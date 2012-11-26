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

var dal_mysql = require("dal-mysql");
var assert = require("assert");
var fs = require("fs");
var lconfig = require("lconfig");
var _ = require("underscore");

function connect(callback) {
  // Verify the configured database is named "test" (for safety and
  // convenience)
  assert.equal(lconfig.database.database, "test");

  // Spin up a database connection (using dal-mysql directly)
  dal_mysql.create(lconfig.database, function (err, instance) {
    assert.ifError(err);
    callback(instance);
  });
}

function loadSqlFiles(filenames) {
  var sql = [];
  filenames.forEach(function (filename) {
    // Load the contents of create_tables.sql
    var script = fs.readFileSync(filename, "utf8");

    // Remove all newlines and then split on semi-colons
    var statements = script.split("\n").join("").split(";");

    // Remove any empty SQL statements
    statements =  _.filter(statements, function (s) { return s.length > 0; });
    sql.push.apply(sql, statements);
  });
  return sql;
}

function dropTables(db, callback) {
  db.query("SHOW TABLES", [], function (err, rows) {
    assert.ifError(err);
    var statements = _.map(rows, function (row) {
      return "DROP TABLE " + _.values(row)[0];
    });

    db.multiquery(statements, function (err) {
      assert.ifError(err);
      callback();
    });
  });
}

exports.reset = function (callback) {
  connect(function (db) {
    // Drop all the tables in the DB
    dropTables(db, function () {
      // Load SQL files
      // TODO: Find a more standardized way of managing schemas
      var sql = loadSqlFiles(["create_tables.sql",
                              "create_tables_entries.sql"]);
      db.multiquery(sql, function (err) {
        assert.ifError(err);
        callback();
      });
    });
  });
};

exports.query = function (sql, binds, callback) {
  connect(function (db) {
    db.query(sql, binds, function (err, rows) {
      assert.ifError(err);
      callback(rows);
    });
  });
};

