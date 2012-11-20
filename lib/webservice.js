/*
*
* Copyright (C) 2011, The Locker Project
* All rights reserved.
*
* Please see the LICENSE file for more information.
*
*/

var express = require('express');
var connect = require('connect');
var request = require('request');
var logger = require('logger').logger("webservice");
var async = require('async');
var path = require('path');
var crypto = require('crypto');
var urllib = require('url');
var authManager = require('authManager');
var taskman = require('taskman');
var servezas = require('servezas');
var taskStore = require('taskStore');
var profileManager = require('profileManager');
var ijod = require('ijod');
var pipeline = require('pipeline');
var dMap = require('dMap');
var acl = require('acl');
var idr = require('idr');
var instruments = require("instruments");
var dal = require('dal');
var qix = require('qix');
var lutil = require('lutil');
var entries = require('entries');
var os = require('os');
var push = require('push');
var posting = require('posting');
var friends = require('friends');
var multi = require('multi');
var lconfig = require('lconfig');

var tstarted;
var total;

var SOURCE_VERSION = 'Unknown';
var CONFIG_VERSION = 'Unknown';

// Given '/services/types?access_token=foo', return 'services'
var RE_FIRST_SEGMENT = /\/([^?\/]+)/;

var hallway = exports.api = express.createServer(
  function(req, res, next) {
    res.jsonErr = function(message, statusCode) {
      res.json(lutil.jsonErr(message), statusCode);
    };
    next();
  },
  // Everything is v0 by default for now
  function(req, res, next) {
    if (req.url.indexOf('/v0/') === 0)
      req.url = req.url.substr(3);

    next();
  },
  // Log the duration of requests
  function(req, res, next) {
    // TODO/node8: Use process.hrtime()
    var start = Date.now();

    if (res._responseTime)
      return next();

    res._responseTime = true;

    var matches = RE_FIRST_SEGMENT.exec(req.url);
    var type = 'request.duration.unknown';

    if (matches) {
      type = 'request.duration.' + matches[1].replace('.', '-');
    }

    // The header event is undocumented; I also
    // tried end but it never triggered.
    res.on('header', function() {
      // TODO/node8: Use process.hrtime()
      var duration = Date.now() - start;
      var data = {};

      data[type] = duration;

      instruments.timing(data).send();
    });

    next();
  },
  connect.bodyParser(),
  connect.cookieParser(),
  function(req, res, next) {
    instruments.increment('api.hits').send();

    logger.debug("REQUEST %s", req.url);

    return next();
  },
  // enable CORS
  function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Accept, Cache-Control, Pragma, User-Agent, Origin, X-Request, Referer, X-Requested-With, Content-Type"
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS, PUT, DELETE"
    );
    next();
  },
  authManager.provider.oauth(),
  authManager.provider.login(),
  function(req, res, next) {
    if (
      req.url.indexOf('/redir/')   === 0 ||
      req.url.indexOf('/auth/')   === 0 ||
      req.url.indexOf('/oauth/')  === 0 ||
      req.url.indexOf('/resources/') === 0 ||
      req.url.indexOf('/enoch')   === 0 ||
      req.url.indexOf('/multi') === 0   ||
      req.url === '/services'           ||
      req.url === '/types'              ||
      req.url === '/state'              ||
      req.url === '/resources.json'     ||
      req._authsome
    ) return next();
    if (req.url === '/') return res.redirect('https://singly.com/');
    res.json(lutil.jsonErr("This request requires a valid access_token."), 401);
  },
  // Keep track of total hits for each API host, reported in /state
  function(req, res, next) {
    if(req._authsome) {
      logger.info("APP HIT", req._authsome.app, req._authsome.account, req.url);
    }
    total++;
    next();
  }
);

// compress by default (using gzippo until express does this natively)
//hallway.use(require('gzippo').compress());

// Authentication callbacks
hallway.get('/auth/:id/auth/:app', function(req, res) {
  if (req.params.id === 'facebook' &&
      (!req.query || !req.query.code)) {
    // redirect, for Facebook Open Graph stuff (see #590)
    return acl.getApp(req.params.app, function(err, app) {
      if (err) return res.send(err, 500);
      if (!app) return res.send(404);
      return res.redirect(app.notes.appUrl);
    });
  }
  authManager.authIsAuth(req.params.id, req.params.app, req, res);
});

hallway.post('/auth/:id/:type/:app', function(req, res) {
  authManager.authIsAuth(req.params.id, req.params.app, req, res);
});

// fallback to use cookie that was set in oauth init stage in authManager
hallway.get('/auth/:id/auth', function(req, res) {
  if (!req.cookies || !req.cookies['auth' + req.params.id]) {
    logger.warn('missing cookie for fallback auth', req.params.id);
    return res.json(lutil.jsonErr("OAuth failed: Missing cookie."), 500);
  }
  logger.debug("authauth here",req.cookies['auth'+req.params.id]);
  authManager.authIsAuth(req.params.id, req.cookies['auth' + req.params.id],
                         req, res);
});

// allows an app to apply their own auth tokens in lieu of the managed auth
hallway.get('/auth/:id/apply', function(req, res) {
  authManager.authApply(req.params.id, req, res);
});

// merge two accounts together
hallway.get('/auth/merge', function(req, res) {
  var source = req.param('source');
  var dest = req.param('dest');
  authManager.authMerge(source, dest, function(err, success){
    if (err) return res.json(lutil.jsonErr(err), 500);
    res.json(success);
  });
});

// batch account creation
hallway.post('/auth/apply/batch', function(req, res) {

  var client_id = req.param('client_id');
  var client_secret = req.param('client_secret');
  var accounts = req.param('accounts');
  if (!(client_id && client_secret)) {
    return res.json(lutil.jsonErr('client_id and client_secret parameters are' +
        ' required', 401));
  }
  if (!Array.isArray(accounts)) {
    return res.json(lutil.jsonErr('accounts parameter must be an array', 400));
  }
  authManager.batchApplyAuth(req, res, client_id, client_secret, accounts,
    function(err, singlyAccounts) {
      if (err) return res.json(lutil.jsonErr(err, 500));
      res.json(singlyAccounts);
  });
});

// Return the client ids for a specific service
hallway.get("/auth/:id/client_id/:service", function(req, res) {
  if (req.params.id && req.params.service) {
    acl.getApp(req.params.id, function(error, appInfo) {
      if (error) {
        return res.json({error:"Unable to retrieve app information"}, 500);
      }

      if (appInfo && appInfo.apikeys && appInfo.apikeys[req.params.service]) {
        var resultInfo = {};
        resultInfo[req.params.service] = appInfo.apikeys[req.params.service].appKey;
        res.json(resultInfo);
      } else {
        res.json({error:"No key found for " + req.params.service}, 404);
      }
    });
  } else {
    res.json({error:"Invalid app or service name."}, 400);
  }
});

// Data access endpoints

// util to xform our legacy _authsome profiles format into something more useful
function profiles(js, services)
{
  var ret = [];
  js.forEach(function(x){
    var parts = x.profile.split('@');
    // if services, it sub-selects just particular ones
    if (services && services.indexOf(parts[1]) === -1) return;
    ret.push(x.profile);
  });
  return ret;
}

function requireJSONBody(req, res, next) {
  var parseFailed = false;
  if (typeof req.body === 'string') try {
    req.body = JSON.parse(req.body);
  } catch (E) {
    logger.error("couldn't parse /profiles/* body", req.body);
    parseFailed = true;
  }
  if (parseFailed || typeof req.body !== 'object') {
    return res.json(lutil.jsonErr("POST body must be a JSON object."), 400);
  }
  return next();
}

// PUBLIC! Return convenient list of all available services
hallway.get('/services', function(req, res) {
  var app = req._authsome ? req._authsome.app : 'public';
  instruments.increment([
    'app.services.discovery.base',
    'app.' + app + '.services.discovery.base'
  ]).send();

  var services = servezas.services();
  res.json(services);
});

// The next few routes are for swagger-enabling the api
// Returns required documentation json to endpoints at /resources.json
// and /resources/*
hallway.set('views', __dirname + '/../resources');
hallway.set('view options', { layout: false });

hallway.get('/resources/services', function(req, res) {
  var services = servezas.services();
  res.header('content-type', 'application/json');
  res.render('services.ejs',{
    locals: {
      services: services
    }
  });
});

// need to document the endpoints that are POST enabled since not consistent
var swagger_post = {
  statuses: {
    body: ['query','The text of the status to share']
  },
  news: {
    body: ['query','Text describing the link'],
    url: ['query','The link']
  },
  photos: {
    photo: ['body', 'The photo you wish to upload']
  }
};
hallway.get('/resources/types', function(req, res) {
  res.header('content-type', 'application/json');
  var types = dMap.types(false, false);
  res.render('types.ejs',{
    locals: {
      types: types,
      post: swagger_post
    }
  });
});
hallway.get('/resources/profile', function(req, res) {
  res.header('content-type', 'application/json');
  res.render('profile.ejs');
});
hallway.get('/resources/friends', function(req, res) {
  res.header('content-type', 'application/json');
  res.render('friends.ejs');
});
hallway.get('/resources/profiles', function(req, res) {
  res.header('content-type', 'application/json');
  res.render('profiles.ejs', {
    locals: {
      serviceNames: Object.keys(servezas.services())
    }
  });
});
hallway.get('/resources.json', function(req, res) {
  res.render('resources.ejs', {
    host: lconfig.lockerBase
  });
});

function getAuthsFromPIDs(pids, app, callback) {
  var auths = {};

  async.forEach(pids, function(pid, cbPID) {
    var service = pid.split('@')[1];
    profileManager.authGet(pid, app, function(err, auth) {
      if (err) return cbPID(err);
      if (!auth) return cbPID();
      auths[service] = {};
      // slightly heuristic
      if (auth.token) {
        if (typeof auth.token === 'string') {
          auths[service].token = auth.token;
          if (typeof auth.tokenSecret === 'string') {
            auths[service].token_secret = auth.tokenSecret;
          } else if(typeof auth.token_secret === 'string') {
            auths[service].token_secret = auth.token_secret;
          }
        } else if (auth.token.oauth_token && auth.token.oauth_token_secret) {
          auths[service] = {
            token: auth.token.oauth_token,
            token_secret: auth.token.oauth_token_secret
          };
        } else auths[service] = auth.token;
      }
      else if (auth.accessToken) auths[service].accessToken = auth.accessToken;

      // clear out instagram's user field
      if (auths[service].user) delete auths[service].user;
      cbPID();
    });
  }, function(err) {
    callback(err, auths);
  });
}

// Simple way to get just a single merged profile view
hallway.get('/profile', function(req, res) {
  instruments.increment([
    'app.profile',
    'app.' + req._authsome.app + '.profile'
  ]).send();

  var addAuth = lutil.isTrue(req.query.auth);
  var bases = [];
  var pids = [];

  req._authsome.profiles.forEach(function(x){
    var pid = (typeof x === 'object') ? x.profile : x;
    pids.push(pid);
    // data is the default for app written data
    var type = dMap.defaults(pid.split('@')[1], 'self') || 'data';
    bases.push(type + ':' + pid + '/self');
  });

  if (bases.length === 0) {
    return res.json(lutil.jsonErr('No data or profile found'), 404);
  }

  var ret = {
    id: req._authsome.account,
    services: {}
  };

  var options = {};
  options.fresh = lutil.isTrue(req.query.fresh);

  entries.runBases(bases, options, function(item) {
    friends.profile(ret, item);
  }, function(err) {
    if (err) logger.error('error sending results for services', err);

    logger.anubis(req, { count: 1 });

    if (ret.email) {
      ret.gravatar = 'https://www.gravatar.com/avatar/' +
        crypto.createHash('md5').update(ret.email.toLowerCase()).digest('hex');
    }

    if (!addAuth) return res.json(ret);
    getAuthsFromPIDs(pids, req._authsome.app, function(err, auths) {
      for (var service in auths) {
        if (ret.services[service]) ret.services[service].auth = auths[service];
      }
      res.json(ret);
    });
  });
});

// Return convenient list of all profiles auth'd for this account
hallway.get('/profiles', function(req, res) {
  instruments.increment([
    'app.profiles',
    'app.' + req._authsome.app + '.profiles'
  ]).send();

  var profiles = req._authsome.profiles;
  var ret = {};
  ret.id = req._authsome.account;
  async.forEach(profiles, function(item, cb) {
    // Skip any that don't look right
    if (!item.profile || item.profile.indexOf('@') === -1) {
      return process.nextTick(cb);
    }

    var parts = item.profile.split('@');
    if (!ret[parts[1]]) ret[parts[1]] = [];
    if (!lutil.isTrue(req.query.data) && !lutil.isTrue(req.query.verify)) {
      ret[parts[1]].push(parts[0]);
      return process.nextTick(cb);
    }
    profileManager.authGet(item.profile, null, function(err, auth){
      if (err || !auth) {
        logger.warn("failed to get auth for ",item.profile,err);
        return cb();
      }
      if (!lutil.isTrue(req.query.verify)) {
        ret[parts[1]].push(auth.profile);
        return cb();
      }
      // if verified, run self synclet!
      var self;
      var wrapper = {id:parts[0]};
      ret[parts[1]].push(wrapper); // changes format to wrapper object so it can be validated
      try {
        self = require(path.join('services', parts[1], 'self.js'));
      } catch (E) {
        // services w/o synclet are custom/internal ones and just skip this
        wrapper.profile = auth.profile;
        return cb();
      }
      logger.info("running verification self for ",item.profile);
      self.sync({auth:auth, config:{}}, function(err, data){
        if(!err && (!data || !data.auth)) err = "no error and no profile data returned, empty response";
        if(err) {
          wrapper.error = err;
        }else{
          wrapper.profile = data.auth.profile;
        }
        cb();
      });
    });
  }, function(err){
    if (err) logger.error("failed to expand data for /profiles ",err);
    logger.anubis(req);
    res.json(ret);
  });
});

// a way to make changes to profiles, just delete for now
hallway.post('/profiles', function(req, res) {
  var account = req._authsome.account;
  if (!account) {
    return res.json(lutil.jsonErr('That account does not exist.'), 404);
  }
  if (!req.param('delete')) {
    return res.json(
      lutil.jsonErr('A "delete" parameter is required.', {
        see: "https://singly.com/docs/profiles#Deleting-Profiles"
      }), 400
    );
  }
  if (req.param('delete') === account) {
    acl.delProfiles(account, function(err, rows){
      if (err) logger.error(err);
      logger.anubis(req);
      res.clearCookie('account-'+req._authsome.app); // def clear the session cookie too so the old id doesn't stick around
      res.json(!err);
    });
  } else {
    var profileID = req.param('delete');
    var lastAt = profileID.lastIndexOf('@');
    // split out the service name and the profile id
    if (lastAt > -1) {
      var service = profileID.substring(lastAt);
      var id = profileID.substring(0, lastAt);
      // the profile id is uri encoded in the DB
      // so we need to encode it here to match
      id = encodeURIComponent(id);
      profileID = id + service;
    }
    acl.getProfile(account, profileID, function(err, profile) {
      if (err) logger.error(err);
      if (!profile) {
        return res.json(lutil.jsonErr('That profile is not connected.'), 404);
      }
      logger.info("deleting account profiles for " + account,
        profileID,
        req._authsome.profiles
      );
      acl.delProfile(account, profileID, function(err, rows){
        if (err) logger.error(err);
        logger.anubis(req);
        res.json(!err);
      });
    });
  }
});

// delete an account RESTfully
hallway['delete']('/profiles', function(req, res, next) {
  logger.info("DELETE account",req._authsome);
  acl.delProfiles(req._authsome.account, function(err, rows){
    if (err) logger.error(err);
    logger.anubis(req);
    res.json({success:true});
  });
});

// delete profiles RESTfully
hallway['delete']('/profiles/:id', function(req, res, next) {
  var id = req.params.id;
  var bye = [];
  profiles(req._authsome.profiles).forEach(function(pid){
    if(pid.indexOf(id) >= 0) bye.push(pid);
  });
  if(bye.length === 0) return res.json(lutil.jsonErr('no matching profiles for '+id));
  logger.info("DELETE profiles for",req._authsome.account,bye);
  async.forEach(bye, function(pid, cbBye){
    acl.delProfile(req._authsome.account, pid, function(err, rows){
      if (err) logger.error(err);
      cbBye();
    });
  }, function(){
    logger.anubis(req);
    res.json({success:true});
  });
});


// endpoints for reading/writing push information for this account
hallway.post('/push', requireJSONBody, function(req, res) {
  var entry = {data:req.body, at:Date.now()};
  entry.idr = 'routes:' + req._authsome.account + '@' + req._authsome.app + '/push#custom';
  push.firstRun(req.body, profiles(req._authsome.profiles), function(){
    ijod.batchSmartAdd([entry], function(err){
      if (err) return res.json(lutil.jsonErr(err), 500);
      logger.anubis(req);
      res.json(entry);
    });
  });
});
// special case, don't clobber existing routes, and safely run it first then merge it
hallway.post('/push/upsert', requireJSONBody, function(req, res) {
  if (!req.body || Object.keys(req.body).length === 0) return res.json(lutil.jsonErr("missing routes"), 500);
  push.firstRun(req.body, profiles(req._authsome.profiles), function(){
    ijod.getOne('routes:' + req._authsome.account + '@' + req._authsome.app + '/push#custom', function(err, entry) {
      // create holder if none
      if (!entry) {
        entry = {data:{}, at:Date.now()};
        entry.idr = 'routes:' + req._authsome.account + '@' + req._authsome.app + '/push#custom';
      }
      // merge
      Object.keys(req.body).forEach(function(key){
        entry.data[key] = req.body[key];
      });
      ijod.batchSmartAdd([entry], function(err){
        if (err) return res.json(lutil.jsonErr(err), 500);
        logger.anubis(req);
        res.json(entry);
      });
    });
  });
});
hallway.get('/push', function(req, res) {
  ijod.getOne('routes:' + req._authsome.account + '@' + req._authsome.app + '/push#custom', function(err, entry) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(entry);
  });
});

// save a custom profile for an app account
hallway.post('/profiles/:serviceName', requireJSONBody, function(req, res) {
  var service = req.params.serviceName;
  if (service === 'self') service = req._authsome.app;
  if (service !== req._authsome.app) {
    return res.json(lutil.jsonErr("Can't write to " + service), 500);
  }
  // ensure there's a default map for self
  dMap.defaultcheck(service, 'self', 'data');
  // make sure to save who created this!
  var entry = {data:req.body, at:Date.now()};
  entry.idr = 'data:' + req._authsome.account + '@' + service + '/self#' + req._authsome.account;
  pipeline.account(req._authsome.account, service, [entry], function(err){
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(true);
  });
});

// return the profile for a given service
hallway.get('/profiles/:serviceName', function(req, res) {
  var service = req.params.serviceName;
  if (service === 'self') service = req._authsome.app;
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if (item.profile.indexOf(service) >= 0) pid = item.profile;
  });
  if (service.indexOf('@') > 0) service = service.split('@')[1]; // allow id@service requests
  if (service === req._authsome.app) pid = [req._authsome.account, req._authsome.app].join('@');
  var type = dMap.defaults(service, 'self');
  if (!pid || !type) {
    return res.json(lutil.jsonErr('There is no profile for ' + service), 404);
  }
  // need to get both because built in services have their own type, and custom profiles (above) have a specific one :/
  var bases =  [type + ':' + pid + '/self', 'data:' + pid + '/self'];
  var self;
  entries.runBases(bases, {limit: 1}, function(item) {
    self = item;
  }, function(err) {
    if (err) logger.warn(err);
    if (!self) return res.json(lutil.jsonErr("No data"), 404);
    logger.anubis(req);
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    if (!lutil.isTrue(req.query.auth)) return res.end(entries.toString(self, entries.options(req.query)));
    // be nice and return tokens
    profileManager.authGet(pid, req._authsome.app, function(err, auth){
      self.auth = {};
      // slightly heuristic
      if (auth && auth.accessToken) self.auth.accessToken = auth.accessToken;
      if (auth && auth.token) self.auth.token = auth.token;
      res.end(entries.toString(self, entries.options(req.query)));
    });
  });
});

// see the state of any tasks for a profile
hallway.get('/profiles/:serviceName/tasks', function(req, res) {
  var service = req.params.serviceName;
  if (service === 'self') service = req._authsome.app;
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if (item.profile.indexOf(service) > 0) pid = item.profile;
  });
  if (service === req._authsome.app) pid = [req._authsome.account, req._authsome.app].join('@');
  if (!pid) {
    return res.json(lutil.jsonErr('There is no profile for ' + service), 404);
  }
  taskStore.getTasks(pid, function(err, tasks) {
    logger.anubis(req);
    res.json(tasks);
  });
});

// nice discovery mechanism!
hallway.get('/types', function(req, res) {
  instruments.increment([
    'app.types.discovery.base',
    'app.' + (req._authsome ? req._authsome.app : 'public') + '.types.discovery.base'
  ]).send();

  if (req.query.q) {
    instruments.increment([
      'app.features.search',
      'app.' + (req._authsome ? req._authsome.app : 'public') + '.features.search'
    ]).send();
  }

  if (req.query.near) {
    instruments.increment([
      'app.features.geo',
      'app.' + (req._authsome ? req._authsome.app : 'public') + '.features.geo'
    ]).send();
  }

  var types = {};
  var bases = {};
  var pros = req._authsome && profiles(req._authsome.profiles, req.query.services);
  dMap.types(false, pros).forEach(function(type){
    types[type] = 0;
    if (!req._authsome) return;
    dMap.types(type, pros).forEach(function(base){
      bases[base] = type;
    });
  });
  if (!req._authsome) return res.json(types);
  // count each base if auth'd
  var options = entries.options(req.query);
  async.forEach(Object.keys(bases), function(base, cb){
    // all ones are special
    if (base.indexOf('all') === 0) {
      return process.nextTick(cb);
    }
    ijod.getBounds(base, options, function(err, bounds){
      var all = (bases[base].indexOf('_feed') > 0) ? 'all_feed' : 'all';
      if (lutil.isTrue(req.query.rich)){
        if (!types[bases[base]]) types[bases[base]] = {};
        types[bases[base]][base] = bounds || {newest:0, oldest:0, total:0};
        if (!types[all]) types[all] = {};
        types[all][base] = bounds || {newest:0, oldest:0, total:0};
        return cb();
      }
      if (!bounds) return cb();
      types[bases[base]] += bounds.total;
      if (!types[all]) types[all] = 0;
      types[all] += bounds.total;
      cb();
    });
  }, function(){
    return res.json(types);
  });
});

// columbus is my friend
hallway.get('/friends', function(req, res) {

  var bases = entries.bases('/types/contacts', req.query, req._authsome.profiles);
  if (bases.length === 0) return res.json({}, 404);
  bases.push('friend:'+req._authsome.account+'@'+req._authsome.app+'/friends');

  var options = entries.options(req.query);

  friends.baseMerge(bases, options, function(err, list){
    var ret = {"all":0};
    if(!list || list.length === 0) return res.json(ret);
    list.forEach(function(friend){
      ret.all++;
      friend.profiles.forEach(function(prof){
        var r = idr.parse(prof.base);
        // handle statuses differently
        if(r.host === req._authsome.app) {
          var statuses = friends.status(prof.pars);
          Object.keys(statuses).forEach(function(status){
            if(!ret[status]) ret[status] = 0;
            ret[status]++;
          });
          return;
        }
        // use device names
        if(r.host === "devices") {
          var name = r.auth.split('.')[0];
          if(!ret[name]) ret[name] = 0;
          ret[name]++;
          return;
        }
        if(!ret[r.host]) ret[r.host] = 0;
        ret[r.host]++;
      });
    });
    return res.json(ret);
  });
});

// handy util to match a device id from list of profiles
function profiles2device(pros, device) {
  var ret = false;
  profiles(pros, ['devices']).forEach(function(pid){
    if(pid.indexOf(device+'.') === 0) ret = pid;
  });
  return ret;
}

// friends are special, aren't they tho?
hallway.get('/friends/:group', function(req, res) {
  var group = req.params.group;
  var bases = [];
  if(group === "all" || group === "peers")
  { // these must always fetch all
    bases = entries.bases('/types/contacts', req.query, req._authsome.profiles);
  }else if(profiles2device(req._authsome.profiles, group)){
    // fetch any devices
    bases = dMap.types('contacts', [profiles2device(req._authsome.profiles, group)]);
  }else{
    // anything else falls through to a service name, which we pass in to filter the bases
    req.query.services = group;
    bases = entries.bases('/types/contacts', req.query, req._authsome.profiles);
  }
  if (bases.length === 0) return res.json([], 404);

  var options = entries.options(req.query);
  if(req.query.bio) options.bio = req.query.bio; // non-standard
  options.fresh = lutil.isTrue(req.query.fresh);

  // Default to returning 20 friends per call
  if (!options.limit) {
    options.limit = 20;
  }

  // Return max. 100 friends per call
  if (options.limit > 100) {
    options.limit = 100;
  }

  options.offset = parseInt(req.query.offset, 10) || 0;
  var sort = options.sort = req.query.sort || 'first';

  // include our account status tracking, http://www.youtube.com/watch?v=iqu132vTl5Y
  options.ace = 'friend:'+req._authsome.account+'@'+req._authsome.app+'/friends';
  bases.push(options.ace);

  logger.debug("FRIENDS",options,bases);

  friends.baseMerge(bases, options, function(err, list){
    if(lutil.isTrue(req.query.debug)) {
      // remove circular
      list.forEach(function(friend) {
        friend.profiles.forEach(function(prof){
          delete prof.merged;
        });
      });
      return res.json(list);
    }
    // handle peers special right now (can be generalized to any state later)
    if(group === "peers") {
      var peers = [];
      list.forEach(function(friend){
        if(friend.peer) peers.push(friend);
      });
      list = peers;
    }
    var ret = [];
    if(!list || list.length === 0) return res.json(ret);
    // first sort the whole list
    list.sort(function(a,b){
      return friends.sorts(sort, a[sort], b[sort]);
    });
    // only expand the asked for chunk
    async.forEach(list.slice(options.offset, options.offset + options.limit), function(friend, cbList){
      var fprof = friends.profile();
      async.forEach(friend.profiles, function(profile, cbProfs){
        if(profile.base === options.ace)
        { // these are the state tracking parallels between accounts
          var statuses = friends.status(profile.pars);
          if(!statuses.peers) {
            return process.nextTick(cbProfs);
          }
          return ijod.getOnePars(profile.id, false, function(err, one){
            if(one && one.path) fprof.peer = one.path; // where we stashed the counterpart's id within this app
            cbProfs();
          });
        }
        ijod.getOne(profile.id, function(err, entry) {
          if(!entry) {
            logger.warn("couldn't fetch friend",profile.id,err);
            return cbProfs();
          }
          if(!friends.validate(entry, options)) return cbProfs(); // TODO handle the limit/offset w/ invalidation!
          friends.profile(fprof, entry, true);
          // util to get full raw data
          if(lutil.isTrue(req.query.full))
          {
            var service = idr.parse(entry.idr).host;
            if(!fprof.full) fprof.full = {};
            fprof.full[service] = entry;
          }
          cbProfs();
        });
      }, function() {
        if(Object.keys(fprof.services).length > 0)
        {
          ret.push(fprof);
        }else{
          logger.warn("skipping friend",fprof,friend);
        }
        cbList();
      });
    }, function(err){
      // re-sort the alphas again!
      if(sort === 'first' || sort === 'last') {
        ret.sort(function(a,b) {
          return friends.sorts(sort, friends.name(a.name)[sort], friends.name(b.name)[sort]);
        });
      }
      if(sort === 'connected') {
        ret.sort(function(a,b) {
          return friends.sorts(sort, Object.keys(a.services).length, Object.keys(b.services).length);
        });
      }
      // optionally send a table of contents of the alpha breakdown for framing out address-book style views
      if(lutil.isTrue(req.query.toc)) ret.unshift(friends.ginTonic(list,sort));
      res.json(ret);
    });
  });
});

// custom lists for mobile clients
hallway.post('/friends/:device', requireJSONBody, function(req, res) {
  var device = encodeURIComponent(req.params.device);

  function dGet(callback)
  {
    var existing = profiles2device(req._authsome.profiles, device);
    if(existing) return callback(existing);
    acl.addDevice(req._authsome.account, req._authsome.app, device, function(err, meta){
      if(err || !meta) return res.json(lutil.jsonErr(err), 500);
      callback(meta.profile);
    });
  }

  // either get existing or creates new
  dGet(function(pid){
    entries.write(req.body, {base:'contact:'+pid+'/contacts'}, function(err, entries){
      if (err) return res.json(lutil.jsonErr(err), 500);
      logger.anubis(req);
      res.json(entries);
    });
  });
});

// return a feed of data from your friends
hallway.get('/feed/:group', function(req, res) {
  var group = req.params.group;
  if(group !== 'peers') return res.json(lutil.jsonErr('unknown feed type'), 404); // for now

  // first get the list of peers
  var peers = ['friend:'+req._authsome.account+'@'+req._authsome.app+'/friends'];
  friends.baseMerge(peers, {ace:peers[0]}, function(err, list){
    var ret = [];
    if(!list || list.length === 0) return res.json(ret);
    // construct all the bases
    var bases = [];
    var peers = [req._authsome.account];
    list.forEach(function(peer){
      peers.push(peer.peer);
      bases.push(['data:',peer.peer,'@',req._authsome.app,'/feed_peers'].join(''));
    });
    var options = entries.options(req.query);
    logger.debug('feeds ',bases,options);
    var items = [];
    var refs = false;
    entries.runBases(bases, options, function(item) {
      if(item.data && item.data.ref) refs = true;
      items.push(item);
    }, function(err) {
      if (err) logger.error('error sending results for services',err);
      logger.anubis(req, {count:items.length});
      if(!refs) return res.json(items);
      // in order to verify the referred to entries are legit for access, the profiles need to be checked
      acl.getManyProfiles(req._authsome.app, peers, function(err, profiles){
        profiles = profiles || {};
        async.forEach(items, function(item, cbItems){
          if(!item.data || !item.data.ref) return process.nextTick(cbItems);
          ijod.getOne(item.data.ref, function(err, entry){
            if(!entry) return cbItems();
            var pid = idr.pid(entry.idr);
            if (!profiles[pid]) {
              logger.warn("attempt to access unauth'd entry",item.idr,entry.idr);
              return cbItems();
            }
            item.entry = entry;
            cbItems();
          });
        }, function(){
          res.json(items);
        });
      });
    });
  });
});

// convenient way to save items to a feed
hallway.post('/feed/:group', requireJSONBody, function(req, res) {
  var group = encodeURIComponent(req.params.group);

  var base = 'data:'+req._authsome.account+'@'+req._authsome.app + '/feed_' + group;
  entries.write(req.body, {base:base}, function(err, entries){
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(entries);
  });
});


// our mega typo
hallway.get('/types/:type', function(req, res) {
  var type = req.params.type;

  if (lutil.isTrue(req.query.map)) {
    instruments.increment([
      'app.features.map',
      'app.' + req._authsome.app + '.features.map'
    ]).send();
  }

  if (req.query.fields) {
    instruments.increment([
      'app.features.fields',
      'app.' + req._authsome.app + '.features.fields'
    ]).send();
  }

  if (req.query.near) {
    instruments.increment([
      'app.features.geo',
      'app.' + req._authsome.app + '.features.geo'
    ]).send();
  }

  if (req.query.q) {
    instruments.increment([
      'app.features.search',
      'app.' + (req._authsome ? req._authsome.app : 'public') + '.features.search'
    ]).send();
  }

  instruments.increment([
    'app.types.rollup',
    'app.types.' + type,
    'app.' + req._authsome.app + '.types.rollup',
    'app.' + req._authsome.app + '.types.' + type
  ]).send();

  var bases = entries.bases(req.url, req.query, req._authsome.profiles);
  if (bases.length === 0) return res.json([], 404);

  var options = entries.options(req.query);
  options.fresh = lutil.isTrue(req.query.fresh); // only support this in a webservice call

  logger.debug("TYPE", type,options,bases);

  var ret = [];
  var start = Date.now();
  var fin = false;
  res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
  res.write('[');
  var written = 0;

  // called whenever there might be more data to write,
  // but ensures it's sequential
  function writer() {
    if (ret.length === 0 && fin) {
      logger.anubis(req, {count:written});
      logger.debug("writer fin!",written);
      if (lutil.isTrue(req.query.debug)) {
        if (written > 0) res.write(',');
        res.write(JSON.stringify({options:options, count:written, time:(Date.now() - start)}));
      }
      return res.end(']');
    }
    if (ret.length === 0) return;
    if (ret[0].oembed === "failed") return writer(ret.shift()); // oembed lookup failed :(
    if (typeof ret[0].oembed !== 'object') return; // wait here until it's an object!
    if (ret[0].map) ret[0].map.oembed = ret[0].oembed; // to reduce confusion have it in the map too and make it consistent
    if (written > 0) res.write(',');
    written++;
    res.write(entries.toString(ret.shift(), options));
    writer();
  }
  var oq = async.queue(function(item, cb){
    ijod.getOne(item.oembed, function(err, oembed) {
      item.oembed = (oembed && oembed.data && !oembed.data.err) ? oembed.data : "failed";
      if (oembed && !item.types[oembed.type]) item.types[oembed.type] = true;
      writer();
      cb();
    });
  }, 100);
  entries.runBases(bases, options, function(item, base){
    entries.typist(item, base, {type:type});
    // oembed is required!
    if (!item.oembed) {
      logger.warn("missing oembed!",base,item.idr,item.refs);
      return;
    }
    ret.push(item);
    if (typeof item.oembed === 'object') return writer(); // already has full .oembed might be writeable
    // async'ly look up the oembed
    oq.push(item);
  }, function(err){
    if (err) logger.error("type fetch error",err);
    fin = true;
    writer(); // might be last, might be more happening yet, don't care
  });
});

hallway.post('/types/:type', posting.postType);

hallway.get('/by/contact/:service/:id', function(req, res) {
  instruments.increment([
    'app.features.by.rollup',
    'app.features.by.contact',
    'app.' + req._authsome.app + '.features.by.rollup',
    'app.' + req._authsome.app + '.features.by.contact'
  ]).send();

  var service = req.params.service;
  var id = req.params.id;
  if (qix.chunk(id).length === 0) return res.json([], 404);
  var profiles = [];
  req._authsome.profiles.forEach(function(item) {
    if (!item.profile || item.profile.indexOf('@') === -1) return; // skip any that don't look right
    if (item.profile.indexOf(service) > 0) profiles.push(item.profile); // just the service profile
  });
  var bases = dMap.types('contacts', profiles);
  var ret = [];
  var options = entries.options(req.query);
  options.q = id;
  var skips = {};
  async.forEach(bases, function(base, cb){
    ijod.getRange(base, options, function(item) {
      if (skips[item.id]) return; // don't send back plain dups!
      skips[item.id] = true;
      item.oembed = dMap.get('oembed', item.data, item.idr);
      //
      // if media="proxy" and a photo, fully proxy the image so it's cors accessible
      if (req.query.media === "proxy" && item.oembed && item.oembed.thumbnail_url) {
        return request.get({url:item.oembed.thumbnail_url}).pipe(res);
      }

      // if media=true and a photo, return the first one as a friendly thing!
      if (lutil.isTrue(req.query.media) && item.oembed && item.oembed.thumbnail_url) {
        return res.redirect(item.oembed.thumbnail_url);
      }

      ret.push(item);
    }, cb);
  }, function(err) {
    logger.anubis(req, {count: ret.length});
    if (ret.length === 0) return res.json(ret, 404);
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    res.end('[' + ret.map(function(entry) {
      return entries.toString(entry, options);
    }).join(',') + ']');
  });
});

hallway.get('/logout', function(req, res) {
  var appId = req._authsome.app;
  var redirectUri;
  res.clearCookie('account-'+appId);
  acl.getApp(appId, function(err, app) {
    if (err) return res.json(lutil.jsonErr(err), 500);

      if (req.query.redirect_uri) {
        redirectUri = req.query.redirect_uri;
      }
      else {
        var redirect = urllib.parse(app.notes.callbackUrl);
        delete redirect.pathname;
        redirectUri = urllib.format(redirect);
      }
      console.log(redirectUri);
      res.redirect(redirectUri);
  });
});

// public health check
hallway.get('/enoch', function(req, res) {
  var good = req.query['true'] || true;
  var bad = req.query['false'] || false; if (req.query.fail) return res.json(bad, 500);
  dal.query('select true', [], function(err, row) {
    if (err) return res.json(bad, 500);
    if (!row || !row[0] || row[0].TRUE !== '1') return res.json(bad, 500);
    res.json(good);
  });
});

// public state information
hallway.get('/state', function(req, res) {
  var ret = {
    sourceVersion: SOURCE_VERSION,
    configVersion: CONFIG_VERSION,
    total: total,
    uptime: parseInt((Date.now() - tstarted) / 1000, 10),
    host: require("os").hostname(),
    os: {
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem()
    }
  };

  res.json(ret);
});

// get apps for an account
hallway.get('/apps', function(req, res) {
  var account = req._authsome.account;
  acl.getAppsForAccount(account, function(err, js) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(js);
  });
});

// get details for a single app
hallway.get('/app/:id', function(req, res) {
  var appId = req.params.id;
  var account = req._authsome.account;
  acl.getAppFor(appId, account, function(err, app) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(app);
  });
});

/* Get the number of accounts for a given app. Can later
   be extended to return json of account id to profile ids. */
hallway.get('/app/:id/accounts', function(req, res) {
  var appId = req.params.id;
  var account = req._authsome.account;
  //get to enable ownership check
  acl.getAppFor(appId, account, function(err, app) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    acl.getAppAccountCount(appId, function(err, count) {
      if (err) return res.json(lutil.jsonErr(err), 500);
      logger.anubis(req);
      res.json(count);
    });
  });
});

// create a new app (primarily for a developer, but could be used for anyone someday)
hallway.post('/app', requireJSONBody, function(req, res) {
  // make sure to save who created this!
  req.body.account = req._authsome.account;
  acl.addApp(req.body, function(err, js){
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(js);
  });
});


function deleteApp(appId, account, req, res)
{
  acl.getApp(appId, function(err, app) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    // only the primary person can delete the app
    if (account === app.notes.account) {
      acl.deleteApp(appId, function(err) {
        if (err) return res.json(lutil.jsonErr(err), 500);
        logger.anubis(req);
        res.send(200);
      });
    } else if(acl.hasAppPerms(account, app)){
      res.json(lutil.jsonErr("only the app creator can delete it"), 401);
    } else {
      res.send(404);
    }
  });
}

// delete an app RESTfully
hallway['delete']('/app/:id', function(req, res, next) {
  deleteApp(req.params.id, req._authsome.account, req, res);
});

// delete an app using a post request for old html forms
hallway.post('/app/:id', requireJSONBody, function(req, res, next) {
  // check for special delete field
  if ( req.body.method === 'DELETE') {
    deleteApp(req.params.id, req._authsome.account, req, res);
  } else {
    next();
  }
});

// update details for a single app
hallway.post('/app/:id', requireJSONBody, function(req, res) {
  var appId = req.params.id;
  // load the app
  var account = req._authsome.account;
  acl.getAppFor(appId, account, function(err, app) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    var notes = req.body;
    // this isn't mutable
    notes.account = app.notes.account;
    // this should be preserved if not changed
    if(!Array.isArray(notes.collab) && app.notes.collab) notes.collab = app.notes.collab;
    var apiKeys;
    try {
      apiKeys = JSON.parse(req.body.apiKeys);
      lutil.trimObject(apiKeys);
    }catch(E){}
    if(!apiKeys) return res.json(lutil.jsonErr("failed to parse api keys"), 500);
    delete notes.apiKeys;
    acl.updateApp(appId, notes, apiKeys, function(err) {
      if (err) return res.json(lutil.jsonErr(err), 500);
      logger.anubis(req);
      res.send(200);
    });
  });
});

// default push settings for an app
hallway.post('/app/:id/push', requireJSONBody, function(req, res) {
  var appId = req.params.id;
  // load the app
  var account = req._authsome.account;
  acl.getAppFor(appId, account, function(err, app) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    var entry = {data:req.body, at:Date.now()};
    entry.idr = 'routes:' + req._authsome.app + '/push#default';
    ijod.batchSmartAdd([entry], function(err){
      if (err) return res.json(lutil.jsonErr(err), 500);
      logger.anubis(req);
      res.json(entry);
    });
  });
});

hallway.get('/app/:id/push', function(req, res) {
  var appId = req.params.id;
  // load the app
  var account = req._authsome.account;
  acl.getAppFor(appId, account, function(err, app) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    ijod.getOne('routes:' + req._authsome.app + '/push#default', function(err, entry) {
      if (err) return res.json(lutil.jsonErr(err), 500);
      logger.anubis(req);
      res.json(entry);
    });
  });
});


hallway.get('/services/:serviceName/_config', function(req, res) {
  var service = req.params.serviceName;
  var profiles = req._authsome.profiles;
  var pid;
  for (var i in profiles) {
    var both = profiles[i].profile.split('@');
    if (both[1] === service) {
      pid = profiles[i].profile;
      break;
    }
  }
  if (!pid) return res.json(lutil.jsonErr('no profile for ' + service), 400);
  profileManager.configGet(pid, function(err, config) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    res.json(config);
  });
});

// Get an individual object (pardon the stupidlication for now)
hallway.get('/services/:serviceName/:serviceEndpoint/:id', function(req, res) {
  var service = req.params.serviceName;
  // self is just an alias, fill in other stuff to match
  if (service === 'self') {
    service = req._authsome.app;
    req.url = '/services/'+service+'/'+req.params.serviceEndpoint;
    req._authsome.profiles.push({profile:req._authsome.account+'@'+service}); // this is sorta hidden by default but is needed to validate
  }
  var profiles = req._authsome.profiles;
  var pid;
  profiles.forEach(function(item) {
    if (item.profile.indexOf('@'+service) > 0) pid = item.profile;
  });
  if (service === req._authsome.app) pid = req._authsome.account+'@'+req._authsome.app;
  var type = dMap.defaults(service, req.params.serviceEndpoint);
  if (!pid || !type) {
    return res.json(lutil.jsonErr('There is no profile for ' + service), 404);
  }

  // construct the base, get the default type for this endpoint
  var base =  type + ':' + pid + '/' + req.params.serviceEndpoint + '#' + req.params.id;
  logger.debug('getOne ' + base);
  ijod.getOne(base, function(err, item) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(entries.toString(item, entries.options(req.query)));
  });
});

hallway.post('/services/facebook/og/:action', function(req, res) {
  req.params.type = 'og';
  posting.postType(req, res);
});

// saving data for an app
hallway.post('/services/:serviceName/:serviceEndpoint', requireJSONBody, function(req, res) {
  var service = req.params.serviceName;
  var context = req.params.serviceEndpoint;
  if (service === 'self') service = req._authsome.app;
  if (service !== req._authsome.app) {
    return res.json(lutil.jsonErr("Can't write to " + service), 500);
  }

  var base = 'data:'+req._authsome.account+'@'+service + '/' + context;
  entries.write(req.body, {base:base}, function(err, entries){
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(entries);
  });
});

// Get a set of data from a service + endpoint combo
hallway.get('/services/:serviceName/:serviceEndpoint', function(req, res) {
  var service = req.params.serviceName;
  // is just an alias, fill in other stuff to match
  if (service === 'self') {
    service = req._authsome.app;
    req.url = '/services/'+service+'/'+req.params.serviceEndpoint;
    req._authsome.profiles.push({profile:req._authsome.account+'@'+service}); // this is sorta hidden by default but is needed to validate
  }

  if (lutil.isTrue(req.query.map)) {
    instruments.increment([
      'app.features.map',
      'app.' + req._authsome.app + '.features.map'
    ]).send();
  }

  if (req.query.fields) {
    instruments.increment([
      'app.features.fields',
      'app.' + req._authsome.app + '.features.fields'
    ]).send();
  }

  if (req.query.near) {
    instruments.increment([
      'app.features.geo',
      'app.' + req._authsome.app + '.features.geo'
    ]).send();
  }

  if (req.query.q) {
    instruments.increment([
      'app.features.search',
      'app.' + (req._authsome ? req._authsome.app : 'public') + '.features.search'
    ]).send();
  }

  instruments.increment([
    'app.services.rollup',
    'app.services.' + service + '.rollup',
    'app.services.' + service + '.' + req.params.serviceEndpoint,
    'app.' + req._authsome.app + '.services.rollup',
    'app.' + req._authsome.app + '.services.' + service + '.rollup',
    'app.' + req._authsome.app + '.services.' + service + '.' + req.params.serviceEndpoint
  ]).send();

  var bases = entries.bases(req.url, req.query, req._authsome.profiles);
  if (bases.length === 0) return res.json(lutil.jsonErr('No data or profile found'), 404);
  var options = entries.options(req.query);
  options.fresh = lutil.isTrue(req.query.fresh); // only support this in a webservice call
  var written = 0;
  // write out the return array progressively, pseudo-streaming
  logger.debug('services ',bases,options);
  res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
  res.write('[');
  var start = Date.now();
  entries.runBases(bases, options, function(item) {
    if (written > 0) res.write(',');
    written++;
    res.write(entries.toString(item, options));
  }, function(err) {
    // handling errors here is a bit funky
    if (err) logger.error('error sending results for services',err);
    logger.anubis(req, {count:written});
    if (lutil.isTrue(req.query.debug)) {
      if (written > 0) res.write(',');
      res.write(JSON.stringify({options:options, count:written, time:(Date.now() - start)}));
    }
    return res.end(']');
  });
});

hallway.get("/services/reset", function(req, res) {
  var profiles = req._authsome.profiles;
  async.forEachSeries(profiles, function(item, cbProfile) {
    profileManager.reset(item.profile, function(err) {
      if (err) return cbProfile(err);
      // spoil every base to make sure data gets re-written fully
      async.forEach(dMap.bases([item.profile]), ijod.spoil, function(){
        taskman.syncNow(item.profile, null, cbProfile);
      });
    });
  }, function(err) {
    if (err) return res.json(lutil.jsonErr(err), 500);
    logger.anubis(req);
    res.json(true);
  });
});

// Return a summary of the endpoints
hallway.get('/services/:serviceName', function(req, res) {
  var service = req.params.serviceName;
  // self is just an alias, fill in other stuff to match
  if (service === 'self') {
    service = req._authsome.app;
    req.url = '/services/'+service+'/'+req.params.serviceEndpoint;
    req._authsome.profiles.push({profile:req._authsome.account+'@'+service}); // this is sorta hidden by default but is needed to validate
  }

  if (req.query.near) {
    instruments.increment([
      'app.features.geo',
      'app.' + (req._authsome ? req._authsome.app : 'public') + '.features.geo'
    ]).send();
  }

  instruments.increment([
    'app.services.discovery.rollup',
    'app.services.discovery.' + service,
    'app.' + req._authsome.app + '.services.discovery.rollup',
    'app.' + req._authsome.app + '.services.discovery.' + service
  ]).send();

  var bases = entries.bases(req.url, req.query, req._authsome.profiles);
  if (bases.length === 0) return res.json(lutil.jsonErr('No data or profile found'), 404);
  var ret = {};
  var options = entries.options(req.query);
  // in case this is a custom service, make sure we have the map loaded
  dMap.loadcheck(service, function(){
    async.forEach(bases,function(base, cb){
      var b = idr.parse(base);
      ijod.getBounds(base, options, function(err, bounds){
        if(!bounds) return cb();
        if (lutil.isTrue(req.query.rich)) {
          bounds.base = base;
          bounds.hash = idr.baseHash(base);
          if(ret[b.path]) {
            ret[b.path].others = [];
            ret[b.path].others.push(bounds);
          }else{
            ret[b.path] = bounds;
          }
          return cb();
        }
        if(!ret[b.path]) ret[b.path] = 0;
        ret[b.path] += bounds.total;
        cb();
      });
    }, function(){
      res.json(ret);
    });
  });
});

// Get a system-wide id uniquely
hallway.get('/id/:id', function(req, res) {
  if (req.query.fields) {
    instruments.increment([
      'app.features.fields',
      'app.' + req._authsome.app + '.features.fields'
    ]).send();
  }

  instruments.increment([
    'app.id',
    'app.' + req._authsome.app + '.id'
  ]).send();

  var id = req.params.id || req.url.substr(1);
  logger.debug("fetching "+id);

  // for future use, the second part used for sharding hints, possible validation, etc
  if (id && id.indexOf(':') === -1 && id.indexOf('_') > 0) id = id.substr(0,id.indexOf('_'));

  ijod.getOne(id, function(err, entry) {
    if (err) logger.warn(err);
    if (!entry) return res.json(lutil.jsonErr("ID does not exist."), 404);
    var pid = idr.pid(entry.idr);
    if (pid.indexOf('@') > 0 && profiles(req._authsome.profiles).indexOf(pid) === -1) {
      logger.warn("attempt to access unauth'd entry",id,entry.idr);
      return res.json(lutil.jsonErr("ID does not exist."), 404);
    }
    // catch inappropriate logging requests too
    if (pid.indexOf('@') === -1 && entry.idr.indexOf('/anubis') > 0 && pid !== req._authsome.app) {
      return res.json(lutil.jsonErr("ID does not exist."), 404);
    }
    logger.anubis(req);
    if (!req.query.media) {
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(entries.toString(entry, entries.options(req.query)));
      return;
    }
    // when asking for just the media, try to redirect to it, this should probably be a different endpoint not a flag?
    var media = dMap.get('media', entry.data, entry.idr);
    var oembed;
    if (!media) oembed = dMap.get('oembed', entry.data, entry.idr);
    if (oembed && oembed.type === "photo") media = oembed.url;
    if (oembed && oembed.thumbnail_url) media = oembed.thumbnail_url;
    // if media="proxy" and a photo, cors it
    if (media && req.query.media === "proxy") return request.get({url:media}).pipe(res);
    if (media) return res.redirect(media);
    var mediaf = dMap.media(entry);
    if (!mediaf) return res.json(lutil.jsonErr("No media found."), 404);
    profileManager.authGet(idr.pid(entry.idr), req._authsome.app, function(err, auth){
      if (err || !auth) return res.json(lutil.jsonErr("No media found."), 404);
      mediaf(auth, entry, res);
    });
  });
});

hallway.get('/multi', multi.get);

// generic proxy-authed-to-service util
hallway.all('/proxy/:service/*', function(req, res) {
  var service = req.params.service;

  instruments.increment([
    'app.proxy.rollup',
    'app.proxy.' + service,
    'app.' + req._authsome.app + '.proxy.rollup',
    'app.' + req._authsome.app + '.proxy.' + service
  ]).send();

  var pid;
  req._authsome.profiles.forEach(function(item) {
    if (item.profile.indexOf(service) > 0) pid = item.profile;
  });
  if (!pid) {
    return res.json(lutil.jsonErr('There is no profile for ' + service), 404);
  }
  req.url = '/'+req.params[0];
  delete req.query.access_token;
  logger.debug("proxy fetching ",req._authsome.app,req.method, service, req.url, req.query, req.body);
  profileManager.authGet(pid, req._authsome.app, function(err, auth){
    if (err || !auth) {
      return res.json(
        lutil.jsonErr("No access token available for " + service),
        401
      );
    }
    var proxy;
    try {
      proxy = require(path.join('services', service, 'proxy.js'));
    } catch (E) {
      logger.warn(E);
      return res.json(
        lutil.jsonErr("No proxy available for ", service),
        501
      );
    }
    logger.anubis(req);
    proxy.proxy(auth, req, res);
  });
});

// error handling
hallway.error(function(err, req, res, next) {
  if (err.stack) logger.error(err.stack);
  // TODO:  Decide if this should go to alerting!
  res.json(
    lutil.jsonErr(
      'Something went wrong. Please report details at https://github.com/Singly/API/issues.'
    ), 500
  );
});

exports.startService = function(port, ip, cb) {
  tstarted = Date.now();
  total = 0;

  lutil.hashFile(__dirname + '/../Config/config.json', function (err, hash) {
    if (err) {
      return;
    }

    CONFIG_VERSION = hash;
  });

  lutil.currentRevision(function(err, branch) {
    if (err) {
      return;
    }

    SOURCE_VERSION = branch;
  });

  hallway.listen(port, ip, function() {
    cb(hallway);
  });
};
