var logger = require('logger').logger('partition');
var dal = require('dal');
var idr = require('idr');

// this can be used to return different databases and table names for any part

// best to keep this in one place
function tableize(partition)
{
  return 'Entries_'+partition.substr(0,2).toLowerCase();
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
  return ret;
}

exports.getHash = function(id)
{
  var idp = idParse(id);
  return idp.hash;
};

// return an array of places to read from, in preferential order
exports.readFrom = function(id, cbDone)
{
  var parts = [];
  var idp = idParse(id);
  // always return at least the current centralized one as the fallback
  parts.push({dal:dal, hash:idp.hash, table:'Entries'});
  // if there's a partition, make that one preferred
  if(idp.part) parts.unshift({dal:dal, hash:idp.hash, table:idp.table, partition:idp.part, trump:true});
  cbDone(parts);
};

// return the list of places to write to
// (usually just one but most flexible to get this pattern in place)
exports.writeTo = function(id, cbDone)
{
  var idp = idParse(id);
  // if there's a partition, make that one preferred
  if(idp.part) return cbDone([{dal:dal, hash:idp.hash, table:idp.table, partition:idp.part}]);

  // worst case fallback, shouldn't be happening
  logger.warn("fallback write to central Entries table",id);
  cbDone([{dal:dal, hash:idp.hash, table:'Entries'}]);
};
