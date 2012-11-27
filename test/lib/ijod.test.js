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

var async = require("async");
var lconfig = require("lconfig");
var logger = require("logger").logger("ijod-test");
var assert = require("assert");
var testdb = require("testdb");
var _ = require("underscore");
var ijod = require("ijod");
var dal = require("dal");
var idr = require("idr");

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
//
// Bypass tests if target database is not "test"
//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
if (lconfig.database.database !== "test") {
  logger.warn("Database name not set to 'test'; bypassing IJOD integration tests!");
  return;
}


var origIJODBackend = lconfig.ijod_backend;
var origDALBackend = dal.getBackend();

// Test Data - [{idr, data}] for 10 users, 3 services and 10 photos
var TESTDATA =  _.flatten(
  _.map(_.range(1), function (uid) {
    return _.map(["twitter"], function (svc) {
      return _.map(_.range(1), function (ctx) {
        return {idr: "photos:user" + uid + "@" + svc + "/" + ctx,
                data: "somedatathatshouldbeapicture"};
      });
    });
  })
);

// Helper function to convert a dataset of [{idr, data}, ...] into a map of ranges
function datasetToRange(dataset) {
  return _.groupBy(dataset, function (item) {
    var base = idr.base(item.idr);
    delete base.pathname;
    return idr.toString(base);
  });
}

// Helper function to retrieve all items from test data via IJOD
function getAllOnes(dataset, callback) {
  async.forEachSeries(dataset, function (expected, cont) {
    ijod.getOne(expected.idr, function (err, actual) {
      assert.ifError(err);
      assert.equal(expected.idr, actual.idr);
      assert.equal(expected.data, actual.data);
      cont();
    });
  }, callback);
}

function getRanges(dataset, callback) {
  var ranges = datasetToRange(dataset);
  async.forEachSeries(_.keys(ranges), function (key, cont) {
    var expected = ranges[key];
    var actual = [];
    console.log("Key: " + key);
    ijod.getRange(key, {}, function (value) { actual.push(value); },
                  function (err) {
                    console.log("Actual: " + JSON.stringify(actual));
                    assert.ifError(err);
                    assert.equal(expected, actual);
                    cont();
                  });
  }, callback);
}

describe("ijod", function () {
  before(function (done) {
    ijod.initDB(done);
    dal.setBackend("mysql");
  });

  beforeEach(function (done) {
    // Reset ijod storage memory
    var mem_backend = require('ijod-mem');
    lconfig.ijod_backend = new mem_backend.backend();

    // Reset the database
    testdb.reset(done);
  });

  after(function (done) {
    // Restore original backends
    lconfig.ijod_backend = origIJODBackend;
    dal.setBackend(origDALBackend);
    done();
  });

  it.skip('should use only Entries table by default', function (done) {
    // Force empty partition configuration
    lconfig.partition = {};

    // Insert all the data
    ijod.batchSmartAdd(TESTDATA, function (err) {
      assert.ifError(err);

      // Verify reading back through API functions as expected
      getAllOnes(TESTDATA, function () {
        // Verify that the Entries tables contains all the data
        testdb.query("SELECT COUNT(*) as count FROM ENTRIES", [], function (rows) {
          assert.equal(TESTDATA.length, rows[0].count);
          done();
        });
      });
    });
  }); // it


  it.skip('should read latest data from partition tables', function (done) {
    // Force empty partition configuration for initial insert
    lconfig.partition = {};

    // Insert all the data
    ijod.batchSmartAdd(TESTDATA, function (err) {
      assert.ifError(err);

      // Verify reading back through API functions as expected
      getAllOnes(TESTDATA, function () {
        // Mutate dataset
        var data1 = _.map(TESTDATA, function (entry) {
          return { idr: entry.idr, data: "newdata"};
        });

        // Adjust partition count
        lconfig.partition.size = 2;

        // Store updated dataset
        ijod.batchSmartAdd(data1, function (err) {
          assert.ifError(err);

          // Verify ijod reflects latest changes
          getAllOnes(data1, function () {
            // Drop the original Entries table and reverify all values
            // are still present
            testdb.query("DROP TABLE Entries", [], function () {
              getAllOnes(data1, done);
            });
          });
        });
      });
    });
  }); // it - should read latest data

  it('should read merged data from partition tables', function (done) {
    // Force empty partition configuration for initial insert
    lconfig.partition = {};

    // Insert all the data
    ijod.batchSmartAdd(TESTDATA, function (err) {
      assert.ifError(err);

      // Verify that reading ranges returns expected values
      getRanges(TESTDATA, done);
    });
  }); // it - should read merged data
});
