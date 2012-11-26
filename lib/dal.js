var genericPool = require("generic-pool");
var lconfig = require("lconfig");
var path = require("path");
var async = require('async');
var logger = require("logger").logger("DAL");
var instruments = require("instruments");

var currentBackend = "mysql";
var module = require(path.join(".", "dal-" + currentBackend + ".js"));

exports.create = function(database)
{
  var ret = {database:database};
  ret.pool = genericPool.Pool({
    name: "db",
    create: function(callback) {
      try {
        module.create(database, callback);
      } catch (E) {
        callback(E);
      }
    },
    destroy:function(client) {
      logger.debug("Cleaning up a DB connection");
      try {
        if (module.destroy) module.destroy(client);
      } catch (E) {
        logger.error(E);
      }
    },
    max: (database.maxConnections) || 20,
    idleTimeoutMillis: (database.maxTimeout) || 10000
  });
  // use our pool
  ret.query = function(sql, binds, cbDone){
    exports.query(sql, binds, cbDone, ret.pool);
  };
  return ret;
};

var global = exports.create(lconfig.database);

exports.setBackend = function(backend) {
  currentBackend = backend;
  module = require(path.join(".", "dal-" + currentBackend + ".js"));
};

exports.getBackend = function () { return currentBackend; }

exports.getBackendModule = function() {
  return module;
};

exports.query = function(sql, binds, cbDone, pool) {
  if(!pool) pool = global.pool;

  var startTime = Date.now();
  pool.acquire(function(error, db) {
    if (error) return cbDone(new Error(error));

    return db.query(sql, binds, function(error, rows, res) {
      pool.release(db);
      instruments.timing({"dal.query_length": (Date.now() - startTime)}).send();
      instruments.increment("dal.query_count").send();
      if (cbDone) cbDone(error, rows, res);
    });
  });
};
