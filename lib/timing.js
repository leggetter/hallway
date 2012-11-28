var _ = require('underscore');
_.str = require('underscore.string');
_.mixin(_.str.exports());

function cleanProxy(path) {
  return path.split('/').slice(0,2).join('/'); // Only /proxy/:service
}

var CLEANERS = {
  'proxy' : cleanProxy
};

exports.cleanPath = function(path) {
  path = _.trim(path, '/');

  var base = path.split('/')[0];
  if (CLEANERS[base]) path = CLEANERS[base](path);

  path = path.replace(/\./g, '-').replace(/\//g, '.');

  return path;
};
