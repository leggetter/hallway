var _ = require('underscore');
_.str = require('underscore.string');
_.mixin(_.str.exports());

// Auth URLs come in various shapes :(
function cleanAuth(path) {
  var parts = path.split('/');

  // auth/:app_id/client_id/:service
  if (parts[2] === 'client_id') {
    parts[1] = 'APP_ID';
    return parts.join('/');
  }

  // The rest are all three parts or have the app ID as their fourth
  return parts.slice(0, 3).join('/');
}

// Only /proxy/:service
function cleanProxy(path) {
  return path.split('/').slice(0, 2).join('/');
}

var CLEANERS = {
  'auth'  : cleanAuth,
  'proxy' : cleanProxy
};

exports.cleanPath = function(path) {
  path = _.trim(path.toLowerCase(), '/');

  var base = path.split('/')[0];
  if (CLEANERS[base]) path = CLEANERS[base](path);

  path = path.replace(/\./g, '-').replace(/\//g, '.');

  return path;
};
