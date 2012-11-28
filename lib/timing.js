var _ = require('underscore');
_.str = require('underscore.string');
_.mixin(_.str.exports());

function cleanProxy(path) {
  return path.split('/').slice(0,2).join('/'); // Only /proxy/:service
}

var cleaners = {
  'proxy' : cleanProxy
};

exports.cleanPath = function(path) {
  path = _.trim(path, '/');

  var base = path.split('/')[0];
  if (cleaners[base]) path = cleaners[base](path);

  path = path.replace(/\./g, '-').replace(/\//g, '.');

  return path;
};
