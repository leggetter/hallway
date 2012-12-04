var lutil = require('lutil');
var os = require('os');

var SOURCE_VERSION = 'Unknown';
var CONFIG_VERSION = 'Unknown';

var TIME_STARTED = Date.now();

exports.status = function () {
  return {
    sourceVersion: SOURCE_VERSION,
    configVersion: CONFIG_VERSION,
    host: require("os").hostname(),
    uptime: Math.floor((Date.now() - TIME_STARTED) / 1000),
    os: {
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem()
    }
  };
};

lutil.hashFile(__dirname + '/../Config/config.json', function (err, hash) {
  if (err) {
    return;
  }

  CONFIG_VERSION = hash;
});

lutil.currentRevision(function (err, branch) {
  if (err) {
    return;
  }

  SOURCE_VERSION = branch;
});
