/*
 * Copyright (C) 2012 Singly, Inc. All Rights Reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *    * Redistributions of source code must retain the above copyright
 *      notice, this list of conditions and the following disclaimer.
 *    * Redistributions in binary form must reproduce the above copyright
 *      notice, this list of conditions and the following disclaimer in the
 *      documentation and/or other materials provided with the distribution.
 *    * Neither the name of the Locker Project nor the
 *      names of its contributors may be used to endorse or promote products
 *      derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE LOCKER PROJECT BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

var mysql = require("mysql");
var logger = require("logger").logger("dal-mysql");
var async = require("async");

// TODO: I don't like this here, I want this more generic, fix later
var lconfig = require("lconfig");

var active = 0;

exports.debug = lconfig.debug;

function Db(client, config) {
  this.client = client;
  this.config = config;
  var self = this;

  // Disconnect handler
  function disconnectHandler(client) {
    client.on("error", function (err) {
      if (!err.fatal) return;

      if (err.code !== "PROTOCOL_CONNECTION_LOST") throw err;

      logger.info("Connection to mysql lost, attempting reconnection...");

      client = mysql.createConnection(self.config);
      disconnectHandler(client);
      client.connect(function (err) {
        if (err) throw err;
        logger.info("Reconnected.");
        self.client = client;
      });
    });
  }
  disconnectHandler(this.client);
}

// do the common '?' pattern replacement to bindings for convenience
Db.prototype.sqlize = function (sql, binds) {
  var client = this.client;
  return sql.replace(/\?/g, function () {
    var arg = binds.shift();
    if (arg === undefined) {
      logger.error("invalid number of binds", sql, binds);
      return "''";
    }
    if (arg === null) return 'NULL';
    if (typeof arg === 'number') return arg.toString();

    arg = arg.toString();
    // utf8 4 byte workaround
    var len = arg.length;
    arg = arg.replace(/[\u0080-\uffff]/g, function(ch) {
      var code = ch.charCodeAt(0).toString(16);
      while (code.length < 4) code = "0" + code;
      return "\\u" + code;
    });
    return client.escape(arg);
  });
};

Db.prototype.query = function (sql, binds, cbDone) {
  if (!cbDone) {
    cbDone = function () {};
  }

  var self = this;
  if (binds && binds.length > 0) sql = self.sqlize(sql, binds);
  if (exports.debug) logger.debug(">> mysql: %s", sql);
  //var client = (sql.toLowerCase().indexOf("select") === 0 &&
  //sql.toLowerCase().indexOf("from entries") > 0 &&
  //this.slave.connectedSync()) ? this.slave : this.client;
  var query = self.client.query(sql, function (error, rows) {
    if (exports.debug) logger.debug("<< mysql: %s", sql);
    if (error) return cbDone(new Error(error));
    cbDone(error, rows);
  });
  return { sql: query.sql };
};

// run all the statements at once!
Db.prototype.multiquery = function (statements, cbDone) {
  if (exports.debug) logger.debug(">> multiqueries", statements.length);
  // THIS IS ACTUALLY SYNC!
  //this.client.multiRealQuerySync(statements.join('; '));
  //while (this.client.multiMoreResultsSync()) {
  //  this.client.multiNextResultSync();
  //}
  //cbDone();
  var client = this.client;
  async.forEachSeries(statements, function (sql, cbLoop) {
    client.query(sql, cbLoop);
  }, cbDone);
};

exports.create = function (config, callback) {
  var options = {};

  if (!config) config = {};
  if (config.hostname) options.host = config.hostname;
  if (config.port) options.port = config.port;
  if (config.username) options.user = config.username;
  if (config.password) options.password = config.password;
  if (config.database) options.database = config.database;

  logger.debug("connecting", ++active);

  var client = mysql.createConnection(options);

  client.connect(function (err) {
    if (err) {
      logger.error("Error connecting to mysql");
      logger.error(err);

      return callback(err);
    }

    var instance = new Db(client, options);

    callback(err, instance);
  });
};

exports.destroy = function (instance) {
  logger.debug("disconnecting", --active);

  if (instance && instance.client) instance.client.destroy();
};
