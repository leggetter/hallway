var lconfig = require('lconfig');
var fs = require('fs');
var acl = require('acl');
var logger = require('logger').logger('apiKeys');

var apikeys;
if(lconfig.apikeysPath) {
  apikeys = JSON.parse(fs.readFileSync(lconfig.apikeysPath));
} else {
  apikeys = {};
  for(var envVarName in process.env) {
    if(envVarName.indexOf('API_KEY_') === 0) {
      var service_type = envVarName.substring(8);
      var endOfServiceName = service_type.indexOf('_');
      var service = service_type.substring(0, endOfServiceName);
      var keyType = service_type.substring(endOfServiceName + 1);
      if(!apikeys[service]) apikeys[service] = {};
      apikeys[service][keyType] = process.env[envVarName];
    }
  }
}

// return api keys from an app or globally for a given service
exports.getKeys = function(service, appID, callback) {
  if(!appID) return apikeys[service];
  acl.getApp(appID, function(err, app){
    if(err) {
      // if it's not a valid appID we shouldn't be falling back
      logger.error("failed to get keys for ", service, appID, err);
      return callback();
    }
    if(app && app.apikeys && app.apikeys[service]) return callback(app.apikeys[service]);
    // fallback
    return callback(apikeys[service]);
  });
};

exports.hasOwnKeys = function(app, service) {
  // If the app has any keys
  if (app && app.apikeys) {
    // If keys exists for the service for both the app and Singly
    if (app.apikeys[service] && apikeys[service]) {
      // Return whether the app's keys differ from Singly's keys
      return app.apikeys[service].appKey !== apikeys[service].appKey;
    } else {
      // Return true if keys don't exist for Singly (because they will exist
      // for the app)
      return apikeys[service] === undefined;
    }
  } else {
    return false;
  }
};
