var logger = require('logger').logger('partition');
var dal = require('dal');
var idr = require('idr');
var lconfig = require("lconfig");
var partition = require('partition');

var PART_SIZE = false;
var PARTDB = dal;

exports.init = function()
{
  // how many table chunks
  if(lconfig.partition && parseInt(lconfig.partition.size, 10) > 0)
  {
    PART_SIZE = parseInt(lconfig.partition.size, 10);
  }else{
    PART_SIZE = false;
  }

  // this can be used to return different databases and table names for any part
  if(lconfig.partition.partdb)
  {
    if(!PART_SIZE)
    {
      logger.warn("can't use a partdb without a valid size configured",lconfig.partition);
      process.exit(1);
    }
    logger.info("creating partdb dal");
    PARTDB = dal.create(lconfig.partition.partdb);
  } 
}

// self init on load
exports.init();

// best to keep this in one place
function tableize(partition)
{
  if(PART_SIZE) return 'Entries_'+partition.substr(0, PART_SIZE).toLowerCase();
  return 'Entries';
}

// takes multiple formats
function idParse(id)
{
  var ret = {};
  if (id.indexOf(':') > 0)
  {
    ret.part = idr.partition(id);
    ret.table = tableize(ret.part);
    ret.hash = idr.hash(id);
  } else if (id.indexOf('_') > 0) {
    ret.part = id.split('_')[1];
    ret.table = tableize(ret.part);
    ret.hash = id.split('_')[0];
  } else {
    logger.error("non-partitionable id",id);
    ret.hash = id;
    ret.table = 'Entries';
  }
  // if not partitioned, flip that bit
  if(PART_SIZE === false) delete ret.part;
  return ret;
}

exports.getHash = function(id)
{
  var idp = idParse(id);
  return idp.hash;
};

exports.getPart = function(id)
{
  var idp = idParse(id);
  return idp.part;
};

// return an array of places to read from, in preferential order
exports.readFrom = function(id, cbDone)
{
  var parts = [];
  var idp = idParse(id);
  // always return at least the current centralized one as the fallback
  parts.push({dal:dal, hash:idp.hash, table:'Entries', priority:0});
  // if there's a partition, make that one preferred
  if(idp.part) parts.unshift({dal:PARTDB, hash:idp.hash, table:idp.table, partition:idp.part, priority:1});
  cbDone(parts);
};

// return the list of places to write to
// (usually just one but most flexible to get this pattern in place)
exports.writeTo = function(id, cbDone)
{
  var idp = idParse(id);
  // if there's a partition, make that one preferred
  if(idp.part) return cbDone([{dal:PARTDB, hash:idp.hash, table:idp.table, partition:idp.part}]);

  // worst case fallback, shouldn't be happening
  if(PART_SIZE) logger.warn("fallback write to central Entries table",id);
  cbDone([{dal:dal, hash:idp.hash, table:'Entries'}]);
};

// clean up old copies of a single entry
exports.cleanUp = function(id, cbDone)
{
  var idp = idParse(id);
  // can't clean up ones w/o a partition
  if(!idp.part) return process.nextTick(cbDone);
  var table = tableize(idp.part);
  // if we're not configured to have partitions, bail
  if(table === 'Entries') return process.nextTick(cbDone);

  logger.debug("cleaning up",id);
  // right now, just two tables, verify it's in the newer one first
  PARTDB.query("SELECT hex(idr) FROM "+table+" WHERE idr = x? LIMIT 1", [idp.hash], function(err, rows){
    if(err) logger.warn("error cleaning id",id,err);
    if(!rows || rows.length == 0) {
      logger.warn("told to singular but no newer one found",id);
      return cbDone();
    }
    dal.query("DELETE FROM Entries WHERE idr = x? LIMIT 1", [idp.hash], cbDone);
  });
}