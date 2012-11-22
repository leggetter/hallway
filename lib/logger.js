/**
* Forked from Mikeal Rogers Stoopid project at http://github.com/mikeal/stoopid.
*/
var util = require('util');
var os = require('os');
var colors = require('colors');
var fs = require('fs');
var moment = require('moment');
var lconfig = require('lconfig');

var rlevels = {};
var levels = {
  silly: 10,
  verbose: 100,
  debug: 200,
  info: 300,
  warn: 400,
  error: 500
};

colors.setTheme({
  silly: 'rainbow',
  input: 'grey',
  verbose: 'green',
  prompt: 'grey',
  info: 'cyan',
  data: 'grey',
  help: 'cyan',
  warn: 'yellow',
  debug: 'green',
  error: 'red'
});

function getClientIp(req) {
  var ipAddress;

  // Amazon EC2 / Heroku workaround to get real client IP
  var forwardedIpsStr = req.headers && req.headers['x-forwarded-for'];

  if (forwardedIpsStr) {
    // 'x-forwarded-for' header may return multiple IP addresses in
    // the format: "client IP, proxy 1 IP, proxy 2 IP" so take the
    // the first one
    var forwardedIps = forwardedIpsStr.split(',');
    ipAddress = forwardedIps[0];
  }

  if (!ipAddress) {
    // Ensure getting client IP address still works in
    // development environment
    ipAddress = req.connection && req.connection.remoteAddress;
  }

  return ipAddress;
}

function Handler() {}

Handler.prototype.msg = function () {
  return util.format.apply(this, arguments);
};

function Console() {
  this.filter = levels[lconfig.logging && lconfig.logging.level];
}

util.inherits(Console, Handler);

Console.prototype.prefix = function (logger) {
  return '[' + moment().format('MM/DD/YYYY HH:mm:ss').grey + '][' +
    os.hostname().grey + '][' + logger.name.cyan + '] ';
};

if (process.env.SUPPRESS_TIMESTAMPS) {
  Console.prototype.prefix = function (logger) {
    return '[' + logger.name.cyan + '] ';
  };
}

Console.prototype.onLog = function (logger, level, args) {
  if (level < this.filter) return;
  var msg = util.format.apply(this, args);
  msg = msg[rlevels[level]] || msg;
  msg = this.prefix(logger) + msg;
  if (logger.stripColors) msg = msg.stripColors;
  process.stdout.write(msg + '\n');
};

function File(path) {
  this.filter = -1;
  this.path = path;
  this.writer = fs.createWriteStream(path, { flags: 'a+' });
}

util.inherits(File, Handler);

File.prototype.onLog = function (logger, level, args) {
  if (level < this.filter) return;
  var msg = this.msg.apply(this, args);
  msg = '[' + logger.name + '] ' + msg;
  this.writer.write(msg + '\n');
};

function Logger(name, parent) {
  var self = this;

  self.stripColors = false;

  if (process.env.SUPPRESS_COLORS) {
    self.stripColors = true;
  }

  self.name = name;
  self.parent = parent;
  self._l = false;

  if (parent) {
    self.handlers = parent.handlers;
  } else {
    self.handlers = [];
  }
}

Logger.prototype.logger = function (name) {
  return new Logger(name, this);
};

Logger.prototype._log = function () {
  var args = Array.prototype.slice.apply(arguments);
  var self = this;
  var level;

  if (!self._l) {
    level = args.shift();
  } else {
    level = self._l;
  }

  self.handlers.forEach(function (h) {
    h.onLog(self, level, args);
  });
};

function defineLevel(level) {
  Logger.prototype[level] = function () {
    this._l = levels[level];
    this._log.apply(this, arguments);
    this._l = false;
  };

  rlevels[levels[level]] = level;
}

for (var level in levels) {
  defineLevel(level);
}

Logger.prototype.log = Logger.prototype.info;
Logger.prototype.dir = Logger.prototype.log;

Logger.prototype.time = function (label) {
  this.times = {};
  this.times[label] = Date.now();
};

Logger.prototype.timeEnd = function (label) {
  var duration = Date.now() - this.times[label];

  this.log('%s: %dms', label, duration);
};

var realError = Logger.prototype.error;

Logger.prototype.error = function (err) {
  if (typeof(err) === 'string') this.trace(err);
  else realError.apply(this, [err.stack]);
};

Logger.prototype.trace = function (label) {
  // TODO probably can to do this better with V8's debug object once that is
  // exposed.
  var err = new Error();
  err.message = label || '';
  if (!label) err.name = 'Trace';

  Error.captureStackTrace(err, Logger.prototype.trace);

  realError.apply(this, [err.stack]);
};

Logger.prototype.assert = function (expression) {
  if (!expression) {
    var arr = Array.prototype.slice.call(arguments, 1);
    require('assert').ok(false, util.format.apply(this, arr));
  }
};

Logger.prototype.errorObject = function (err) {
  this.error(err);
  return err;
};

var handlerMap = {
  console: Console,
  file: File
};

Logger.prototype.addHandler = function (handler, options) {
  if (typeof handler === 'string') {
    if (!handlerMap[handler]) {
      throw new Error('no handler named ' + handler);
    }

    handler = new handlerMap[handler](options);
  }

  this.handlers.push(handler);
};

// system to batch archive api requests from an app per account, this could
// prolly move to it's own file once it matures TODO
var tomb = [];
Logger.prototype.anubis = function (req, js) {
  var self = this;

  if ((req && typeof req !== 'object') ||
    (js && typeof js !== 'object')) {
    return self.warn('anubis called w/ invalid args');
  }

  if (!req) req = {}; // if null
  if (!js) js = {};

  if (!((js.app && js.act) || req._authsome)) {
    return self.warn('anubis isn\'t authsome');
  }

  // fill in log entry
  js.at = Date.now();
  js.act = js.act || req._authsome.account;
  js.app = js.app || req._authsome.app;
  js.type = js.type || 'log'; // sanity
  js.path = js.path || req.url;
  js.from = js.from || getClientIp(req);
  js.query = {};

  if (req.query) {
    Object.keys(req.query).forEach(function (key) {
      if (key !== 'access_token') {
        js.query[key] = req.query[key];
      }
    });
  }

  if (req.method && req.method.toLowerCase() !== 'get') {
    js.method = req.method.toLowerCase();
  }

  if (js.path && js.path.indexOf('?') !== -1) {
    js.path = js.path.substr(0, js.path.indexOf('?'));
  }

  tomb.push(js);
};

function reaper() {
  var ijod = require('ijod');
  if (tomb.length === 0) return;
  var doom = tomb;
  tomb = [];

  module.exports.debug('reaping', doom.length);

  var bundle = {};

  // munge the raw list into batch groupings per account@app
  doom.forEach(function (js) {
    var key = [js.act, js.app].join('@');
    if (!bundle[key]) bundle[key] = [];
    bundle[key].push(js);
    delete js.app; // don't need to store this, present in idr
  });

  Object.keys(bundle).forEach(function (key) {
    var parts = key.split('@');
    var act = parts[0];
    var app = parts[1];
    var entry = {
      data: bundle[key],
      at: Date.now()
    };

    // TODO also add other types if the set contains more than log? entry.types
    // needs refactoring first
    // idr is global to app by default
    entry.idr = 'logs:' + app + '/anubis#' + act + '.' + entry.at;

    // also change the base to include the account so it's getRange'able that
    // way (bit of a hack :/)
    entry.types = {
      logs: { auth: act }
    };

    ijod.batchSmartAdd([entry], function (err) {
      if (err) module.exports.error('anubis bsa', err);
    });
  });
}

if( lconfig.logger === undefined || ( lconfig.logger.reap !== false && lconfig.logger.reap !== 'false'  ) ) {
  var reap = setInterval(reaper, 10000);
}

module.exports = new Logger('process');
module.exports.addHandler('console');
