var argv = require('optimist')
    .default('concurrent', 15)
    .boolean('force', false)
    .default('limit', 100)
    .default('offset', 0).argv;
var async = require('async');

var lconfig = require('lconfig');
var logger = require('logger').logger('retasker');
var profileManager = require('profileManager');
var taskman = require('taskman');
var dal = require('dal');
var ijod = require('ijod');

function retask(offset, limit, concurrent, force, service, callback) {
  var sql = 'SELECT id FROM Profiles ';
  var binds = [];
  if(service) {
    sql += 'WHERE service=? ';
    binds.push(service);
  }
  binds.push(limit);
  binds.push(offset);
  sql += 'LIMIT ? OFFSET ?';
  dal.query(sql, binds, function(err, ret) {
    if(err || !ret) return callback(err);
    logger.log("doing "+ret.length+"\n");
    var i = offset;
    async.forEachLimit(ret, concurrent, function(row, cbLoop) {
      logger.log(i++, row.id+"\n");
      profileManager.authGet(row.id, null, function(err, auth) {
        if(!auth) return cbLoop();
        taskman.taskUpdate(auth, function(err) {
          if(err) logger.error([row.id,err,'\n'].join(' '));
          cbLoop();
        }, force);
      });
    }, function(err) {
      if(err) logger.error(err.toString());
      callback();
    });
  });
}

var INITED = false;
function init(callback) {
  if (INITED) return process.nextTick(callback);
  INITED = true;
  ijod.initDB(function(err) {
    if (err) return callback(err);
    taskman.init(null, null, callback);
  });
}

init(function(err) {
  if (err) return logger.error('err', err);
  retask(argv.offset, argv.limit, argv.concurrent, argv.force, argv.service,
    function(err) {
    if (err) logger.error('err', err);
    logger.log('done');
    process.exit();
  });
});
