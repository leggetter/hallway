var logger = require('logger').logger('partition');
var dal = require('dal');
var idr = require('idr');
var lconfig = require("lconfig");

// this can be used to return different databases and table names for any part
var partdb = dal;
if(lconfig.partition.partdb)
{
  logger.info("creating partdb dal");
  partdb = dal.create(lconfig.partition.partdb);
}

// best to keep this in one place
function tableize(partition)
{
  if(lconfig.partition && parseInt(lconfig.partition.size, 10) > 0) return 'Entries_'+partition.substr(0, lconfig.partition.size).toLowerCase();
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
  if(!lconfig.partition || !lconfig.partition.size) delete ret.part;
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
  if(idp.part) parts.unshift({dal:partdb, hash:idp.hash, table:idp.table, partition:idp.part, priority:1});
  cbDone(parts);
};

// return the list of places to write to
// (usually just one but most flexible to get this pattern in place)
exports.writeTo = function(id, cbDone)
{
  var idp = idParse(id);
  // if there's a partition, make that one preferred
  if(idp.part) return cbDone([{dal:partdb, hash:idp.hash, table:idp.table, partition:idp.part}]);

  // worst case fallback, shouldn't be happening
  logger.warn("fallback write to central Entries table",id);
  cbDone([{dal:dal, hash:idp.hash, table:'Entries'}]);
};
