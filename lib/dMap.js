var idr = require('idr');
var fs = require('fs');
var path = require('path');
var logger = require('logger').logger('dMap');
var async = require('async');
var ijod = require('ijod');

var maps = {};

// safely run the mapped functions, id required to be parsed idr
function condom(f, data, id, name) {
  var res;
  try {
    res = f(data, id);
  }catch(E){
    logger.warn("STD",id,name,E,data);
  }
  return res;
}

// util to extract a common key from a raw data json object from a given service
exports.get = function(name, data, base) {
  var r = idr.parse(base);
  var svc = maps[r.host] || maps.system;
  var map = svc[r.protocol] || {};
  if (typeof map[name] === 'function') return condom(map[name],data,r,name);
  return data[map[name] || name];
};

// use a similar pattern for default service-level mapping values
exports.defaults = function(service, name) {
  var svc = maps[service] ||maps.system;
  var map = svc.defaults || {};
  return map[name]; // undefined means there's no default type, doh!
};

// map all the defined fields for an entry
exports.map = function(entry) {
  var ret = {};
  if (!entry || !entry.data) return ret;
  var r = idr.parse(entry.idr);
  if (!r) return ret;
  var svc = maps[r.host] || maps.system;
  var map = svc[r.protocol] || {};
  Object.keys(map).forEach(function(name){
    if (name === 'at') return;
    var x = (typeof map[name] === 'function') ? condom(map[name],entry.data,r,name) : entry.data[map[name]];
    if (x) ret[name] = x;
  });
  return ret;
};

// return a media function if any
exports.media = function(entry) {
  if (!entry || !entry.data) return undefined;
  var r = idr.parse(entry.idr);
  if (!r) return undefined;
  var svc = maps[r.host] || maps.system;
  var media = svc.media || {};
  return media[r.protocol];
};

// look for a guid if supported
exports.guid = function(entry) {
  if (!entry || !entry.data) return undefined;
  var r = idr.parse(entry.idr);
  if (!r) return undefined;
  var svc = maps[r.host] || maps.system;
  if (!svc.guid || !svc.guid[r.protocol]) return undefined;
  return svc.guid[r.protocol](entry);
};

// turn a profile into all possible bases for it
exports.bases = function(profiles) {
  var ret = [];
  if (!profiles) return ret;
  profiles.forEach(function(profile){
    var pid = profile.split('@');
    var svc = maps[pid[1]] || maps.system;
    var defaults = svc.defaults;
    if (!defaults) return;
    Object.keys(defaults).forEach(function(context){
      var r = defaults[context]+":"+profile+"/"+context;
      ret.push(r);
    });
  });
  return ret;
};

// take an idr and figure out what all kinds of types it could be (usually just one)
exports.typeOf = function(id, types) {
  var ret = {};
  id = idr.parse(id);
  var key = idr.toString(idr.key(id));
  Object.keys(maps).forEach(function(service){
    var types = maps[service].types;
    if (!types) return;
    Object.keys(types).forEach(function(type){
      if (types[type].indexOf(key) >= 0) ret[type] = true;
    });
  });
  // if there's other internal types, map those too
  if (types) Object.keys(types).forEach(function(type){
    id.protocol = type;
    exports.typeOf(id).forEach(function(t){
      ret[t] = true;
    });
  });
  return Object.keys(ret);
};

// across all the given profiles, return an array of bases for a given type
exports.types = function(type, profiles) {
  var ret = [];
  if (!profiles) profiles = Object.keys(maps); // use all types if none
  profiles.forEach(function(profile){
    var pid = (profile.indexOf('@') > 0) ? profile.split('@') : [false,profile];
    var svc = maps[pid[1]] || maps.system;
    var types = svc.types;
    if (!types) return;
    // list out all possible types
    if (!type) {
      Object.keys(types).forEach(function(stype){
        if (ret.indexOf(stype) === -1) ret.push(stype);
      });
      return;
    }
    var bases = types[type];
    if (type.indexOf('all') === 0) {
      bases = [];
      Object.keys(types).forEach(function(stype){
        // all must match _feed, lame hard-wired thing meh
        if (stype.indexOf('_feed') > 0 && type.indexOf('_feed') === -1) return;
        if (type.indexOf('_feed') > 0 && stype.indexOf('_feed') === -1) return;
        if (stype === 'contacts') return;
        types[stype].forEach(function(base){
          bases.push(base);
        });
      });
    }
    if (!bases) return;
    bases.forEach(function(base){
      base = idr.clone(base);
      if (pid[0]) base.auth = decodeURIComponent(pid[0]);
      ret.push(idr.toString(base));
    });
  });
  return ret;
};

// run a specific service pumps, usually last
exports.pump = function(cset, callback) {
  cset.forEach(function(entry){
    var r = idr.parse(entry.idr);
    var svc = maps[r.host] || maps.system;
    if (!svc.pumps) return;
    // run all for now, TODO need selectivity here
    Object.keys(svc.pumps).forEach(function(name){
      if (!svc.pumps[name][r.protocol]) return;
      svc.pumps[name][r.protocol](entry);
    });
  });
  callback(null, cset);
};

// return the integer code for the given string type
// services start at 100, to find next one just: grep 'exports.ptype' lib/services/*/map.js
var partypes = {
  'first':1,
  'last':2,
  'email':3,
  'phone':4,
  'handle':5,
  'status':6,
  'url':7,
  'interactions':8,
  'activity':9,
  'photos':10
};
var partyped = []; // built during startup
exports.partype = function(type) {
  if (typeof type === 'number') return partyped[type]; // reverse lookup
  if (partypes[type]) return partypes[type];
  return 0;
};

// dynamically pull in any app maps, this shouldn't be called too often but regularly (at start of pipeline right now)
// is only a prep function, doesn't return anything
// TODO probably need to do more safety containment, maybe domains w/ 0.8?
exports.loadcheck = function(service, callback) {
  if (maps[service] && maps[service]._system) return callback(); // pass-through system loaded ones
  var idr = 'map:'+service+'/maps#default';
  ijod.getOne(idr, function(err, entry){
    if (!entry || !entry.data) return callback();
    if (maps[service] && maps[service]._loaded === entry.at) return callback(); // hasn't changed
    // time to load a new one, someday we'll need to handle dynamic functions, pumps, etc, starting KISS
    logger.debug("loading custom map entry");
    maps[service] = entry.data;
    maps[service]._loaded = entry.at;
    callback();
  });
};

// handy way to make sure there's a default mapping between a context and type, used primarily for app saved data
exports.defaultcheck = function(service, context, type) {
  if (exports.defaults(service, context) === type) return;

  // fetch and rewrite the map to include it!
  var mapidr = 'map:' + service + '/maps#default';
  ijod.getOne(mapidr, function(err, entry) {
    if (err) logger.warn(err);
    var map = (entry && entry.data) || {};
    if (!map.defaults) map.defaults = {};
    if (map.defaults[context]) return; // odd, here already, oh well
    map.defaults[context] = 'data';
    entry = {data:map, at:Date.now(), idr:mapidr};
    logger.debug("saving custom map", entry);
    ijod.batchSmartAdd([entry], function(err){
      if (err) logger.warn(err);
    });
  });
};

// system level defaults
maps.system = {
  defaults: {
    anubis: 'logs',
    self: 'profile'
  },
  logs: {
    text: function(data) {
      var keys = {};
      // return ip as hex and paths
      data.forEach(function(item) {
        if (item.from) keys[item.from.split('.').map(function(y){
          return parseInt(y, 10).toString(16);
        }).join('')]=1; keys[item.path]=1;
      });
      return Object.keys(keys).join(" ");
    }
  }
};

// load any service maps
exports.startup = function(callback) {
  var services = fs.readdirSync(path.join(__dirname,'services'));
  async.forEach(services, function(service, cb){
    var map = path.join(__dirname,'services',service,'map.js');
    fs.exists(map, function(exists){
      if (!exists) return cb();
      logger.debug("mapping", map.replace(/^.*?services\//, ''));
      try {
        maps[service] = require(map);
        maps[service]._system = true;
        if (maps[service].ptype) partypes[service] = maps[service].ptype;
      }catch(E){
        logger.error("failed to load ",map,E);
      }
      cb();
    });
  }, function(){
    // build par type inverse index
    Object.keys(partypes).forEach(function(type){
      if (partyped[partypes[type]]) logger.error("conflicting type!",type,partypes[type],partyped[partypes[type]]);
      partyped[partypes[type]] = type;
    });
    callback();
  });
};
