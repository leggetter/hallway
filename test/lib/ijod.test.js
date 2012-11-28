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
  _.map(_.range(2), function (uid) {
    return _.map(["twitter"], function (svc) {
      return _.map(_.range(2), function (ctx) {
        return {idr: "photos:user" + uid + "@" + svc + "/mentions#" + ctx,
                data: "somedatathatshouldbeapicture"};
      });
    });
  })
);

// Helper function strip keys other than idr, data from a dataset
// (ijod modifies things passed into it, so we lose pristine copies of objects)
function cleanDataset(dataset) {
  return _.map(dataset, function (item) {
    return { idr: item.idr, data: item.data };
  });
}

// Helper function to convert a dataset of [{idr, data}, ...] into a map of ranges
function datasetToRange(dataset) {
  return _.groupBy(dataset, function (item) {
    var base = idr.base(item.idr);
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

// Helper function that implements contains for deep equality of objects
// (With apologies to underscore.js)
_.contains = function (obj, target) {
  if (obj === null) return false;
  return _.any(obj, function (value) {
    return _.isEqual(value, target);
  });
};

// Helper function to extract the bounds on a dataset, by base
function datasetBounds(dataset, state0) {
  return _.foldl(dataset, function (acc, entry) {
    var base = idr.toString(idr.base(entry.idr));
    var accItem = acc[base] || { newest: 0, oldest: Date.now(), total: 0 };
    accItem.oldest = Math.min(accItem.oldest, entry.at);
    accItem.newest = Math.max(accItem.newest, entry.at);
    accItem.total++;
    acc[base] = accItem;
    return acc;
  }, state0 || {});
}


function checkBounds(bounds, callback) {
  async.forEachSeries(_.keys(bounds), function (key, cont) {
    var expected = bounds[key];
    ijod.getBounds(key, {},
                  function (err, actual) {
                    assert.ifError(err);
                    assert.equal(expected.oldest, actual.oldest);
                    assert.equal(expected.newest, actual.newest);
                    assert.equal(expected.total, actual.total);
                    cont();
                  });
  }, callback);
}

function getRanges(dataset, callback) {
  var ranges = datasetToRange(dataset);
  async.forEachSeries(_.keys(ranges), function (key, cont) {
    var expected = cleanDataset(ranges[key]);
    var actual = [];
    ijod.getRange(key, {},
                  function (value) { actual.push(value); },
                  function (err) {
                    assert.ifError(err);
                    actual = cleanDataset(actual);

                    // All actual entries are expected
                    assert.deepEqual([], _.difference(actual, expected));
                    // All expected entries are present
                    assert.deepEqual([], _.difference(expected, actual));
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

  it('should use only Entries table by default', function (done) {
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
  }); // it should use only ...

  var getFns = {"getOne": getAllOnes,
                "getRange": getRanges };
  _.each(_.keys(getFns), function (name) {
    it('should read latest data from partition tables: ' + name, function (done) {
      // Force empty partition configuration for initial insert
      lconfig.partition = {};

      // Insert all the data
      ijod.batchSmartAdd(TESTDATA, function (err) {
        assert.ifError(err);

        // Verify reading back through API functions as expected
        getFns[name](TESTDATA, function () {
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
            getFns[name](data1, function () {
              // Drop the original Entries table and reverify all values
              // are still present
              testdb.query("DROP TABLE Entries", [], function () {
                getFns[name](data1, done);
              });
            });
          });
        });
      });
    }); // it - should read latest data ...
  });

  it('should resolve data across partition tables', function (done) {
    // Force empty partition configuration for initial insert
    lconfig.partition = {};

    // Insert all the data
    ijod.batchSmartAdd(TESTDATA, function (err) {
      assert.ifError(err);

      // Mutate every other entry in the dataset and generate
      // a dataset with the merged changes and one with just
      // changes
      var data1 = [];
      var changelist = [];
      var i = 0;
      _.each(TESTDATA, function (entry) {
        if (i++ % 2 === 0) {
          entry = {idr: entry.idr, data: "newdata"};
          changelist.push(entry);
        }
        data1.push(entry);
      });

      // Adjust partition count
      lconfig.partition.size = 2;

      // Insert mutated data; there should now be data across ranges
      // in old/new tables. We want to verify that the getRange returns
      // data in both old and new
      ijod.batchSmartAdd(changelist, function (err) {
        assert.ifError(err);

        // Validate that getRange returns what we expect from our merged
        // dataset
        getRanges(data1, function () {
          // Calculate bounds across all the datasets (since getBounds does not dedup)
          var bounds = datasetBounds(changelist, datasetBounds(TESTDATA));
          checkBounds(bounds, done);
        });
      });
    });
  }); // it - should resolve data across...

});
