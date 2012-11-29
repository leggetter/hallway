var genericPool = require('generic-pool');
var lconfig = require('lconfig');
var path = require('path');
var async = require('async');
var logger = require('logger').logger('DAL');
var instruments = require('instruments');

var currentBackend = 'mysql';
var module = require(path.join('.', 'dal-' + currentBackend + '.js'));

var WORKER_NAME = process.env.WORKER || require('os').hostname();
var WORKER_KEY = WORKER_NAME.replace(/\..*$/, '');

// set up a global one for sqlize, grr mysql
var base;

module.create(lconfig.database, function (err, db) {
  base = db;
});

var pool = genericPool.Pool({
  name: 'db',
  create: function (callback) {
    try {
      module.create(lconfig.database, callback);
    } catch (E) {
      callback(E);
    }
  },
  destroy: function (client) {
    logger.debug('Cleaning up a DB connection');

    try {
      if (module.destroy) module.destroy(client);
    } catch (E) {
      logger.error(E);
    }
  },
  max: (lconfig.database && lconfig.database.maxConnections) || 20,
  idleTimeoutMillis: (lconfig.database && lconfig.database.maxTimeout) || 10000
});

// Wrap pool.acquire to provide timing information
function timedAcquire(cb) {
  var startTime = Date.now();

  pool.acquire(function (error, db) {
    var stats = {};

    stats['dal.' + WORKER_KEY + '.pool.acquire'] = Date.now() - startTime;

    instruments.timing(stats).send();

    stats = {};

    stats['dal.' + WORKER_KEY + '.pool.size'] = pool.getPoolSize();
    stats['dal.' + WORKER_KEY + '.pool.waiting'] = pool.waitingClientsCount();
    stats['dal.' + WORKER_KEY + '.pool.available'] = pool.availableObjectsCount();

    instruments.gauge(stats).send();

    cb(error, db);
  });
}

exports.setBackend = function (backend) {
  currentBackend = backend;

  module = require(path.join('.', 'dal-' + currentBackend + '.js'));
};

exports.getBackendModule = function () {
  return module;
};

// Helper for a future query debug logger
// E.stack.split('\n')[3].match(/at\s(.*)$/)[1]

// simple utility to run batch at once
exports.bQuery = function (queries, callback) {
  if (!queries || !Array.isArray(queries)) {
    return callback(new Error('passed in queries is not an array'));
  }

  async.forEachSeries(queries, function (scriptSql, cb) {
    exports.query(scriptSql, [], cb);
  }, function (err) {
    if (err) console.error('dal query failed: ', err);

    callback(err);
  });
};

exports.query = function (sql, binds, cbDone) {
  timedAcquire(function (error, db) {
    if (error) return cbDone(new Error(error));

    var startTime = Date.now();

    return db.query(sql, binds, function (error, rows, res) {
      pool.release(db);

      instruments.timing({'dal.query_length': (Date.now() - startTime)}).send();
      instruments.increment('dal.query_count').send();

      if (cbDone) cbDone(error, rows, res);
    });
  });
};

// run bunch of sql commands at once
exports.multiquery = function (sqls, cbDone) {
  timedAcquire(function (error, db) {
    if (error) return cbDone(new Error(error));

    var startTime = Date.now();

    return db.multiquery(sqls, function (ret) {
      pool.release(db);
      instruments.timing({
        'dal.multiquery_length': (Date.now() - startTime)
      }).send();
      if (cbDone) cbDone(ret);
    });
  });
};

// simple pass-through util to escape strings
exports.sqlize = function (sql, binds) {
  return base.sqlize(sql, binds);
};
