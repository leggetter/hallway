// servezas manages reading info from all of the services. It loads their
// synclets.json files and caches them.

var path = require('path');
var fs = require('fs');

var async = require('async');

var logger = require('logger').logger('servezas');

var SERVICES = {};
var SYNCLETS = {};

// loads all the service info. This needs to be called before anything else will
// work. Ideally, this module would auto manage that, but we'll wait until we
// really need that to build it.
exports.load = function(callback) {
  var services = fs.readdirSync(path.join(__dirname,'services'));
  async.forEach(services, function(service, cbLoop) {
    var map = path.join(__dirname, 'services', service, 'synclets.json');
    fs.exists(map, function(exists) {
      if (!exists) return cbLoop();
      logger.debug("loading", map);
      var sjs = SERVICES[service] = JSON.parse(fs.readFileSync(map));
      if (!SYNCLETS[service]) SYNCLETS[service] = {};

      for (var i = 0; i < sjs.synclets.length; i++) {
        var sname = sjs.synclets[i].name;
        var spath = path.join(__dirname, "services", service, sname);
        delete require.cache[spath]; // remove any old one
        SYNCLETS[service][sname] = {
          data: sjs.synclets[i],
          sync: require(spath).sync
        };
        logger.debug("\t* " + sname);
      }

      cbLoop();
    });
  }, callback);
};

// returns an Array of names of the synclets for a service
exports.syncletList = function(service, classes) {
  if (!classes) return Object.keys(SYNCLETS[service]);
  var list = [];
  for (var i in SYNCLETS[service]) {
    var synclet = SYNCLETS[service][i];
    if (synclet.data && classes[synclet.data['class']]) list.push(i);
  }
  return list;
};

// returns the object for this synclet from the service's synclets.json file.
// e.g. (for facebook self)
// {"name": "self", "frequency": 86400, "class": "core"}
exports.syncletData = function(service, synclet) {
  return SYNCLETS[service][synclet].data;
};

// return the full synclet, including the sync function
exports.synclet = function(service, synclet) {
  return SYNCLETS[service][synclet];
};

// return all synclets (data field and sync fn) for service
exports.synclets = function(service) {
  return SYNCLETS[service];
};

// return the full map of services and their synclets
exports.services = function() {
  return SERVICES;
};

// returns an Array of the service names
exports.serviceList = function() {
  return Object.keys(SERVICES);
};

// true if the services supports sandboxed config
exports.isSandboxed = function(service) {
  return SERVICES[service].sandbox;
};
