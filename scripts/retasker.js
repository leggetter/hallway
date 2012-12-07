var argv = require('optimist')
    ['default']('concurrent', 15)
    .boolean('force', false)
    ['default']('limit', 100)
    ['default']('offset', 0).argv;
var async = require('async');

var lconfig = require('lconfig');
var logger = require('logger').logger('retasker');
var profileManager = require('profileManager');
var taskman = require('taskman');
var dal = require('dal');
var ijod = require('ijod');
var servezas = require('servezas');
var taskStore = require('taskStore');
var acl = require('acl');

function retask(pids, concurrent, force, callback) {
  logger.log("doing "+pids.length+"\n");
  var i = argv.offset;
  async.forEachLimit(pids, concurrent, function(row, cbLoop) {
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
}

function getPids(offset, limit, service, callback) {
  var sql = 'SELECT id FROM Profiles ';
  var binds = [];
  if(service) {
    sql += 'WHERE service=? ';
    binds.push(service);
  }
  binds.push(limit);
  binds.push(offset);
  sql += 'LIMIT ? OFFSET ?';
  dal.query(sql, binds, callback);
}

function getOldsTaskPids(callback) {
  var until = Date.now() - (24 * 60 * 60 * 1000);
  var pids = {};
  async.forEachLimit(servezas.serviceList(), 10, function(service, cbService) {
    async.forEachLimit(servezas.syncletList(service), 10, function(synclet, cbSynclet) {
      taskStore.taskRange(service, synclet, {until:until}, function(err, tasks) {
        if (err) return cbSynclet(err);
        for (var i in tasks) {
          var task = tasks[i];
          pids[task.pid] = {id: task.pid};
        }
        cbSynclet();
      });
    }, cbService);
  }, function(err) {
    var rows = [];
    for (var i in pids) { rows.push(pids[i]); }
    return callback(err, rows);
  });
}

var INITED = false;
function init(callback) {
  if (INITED) return process.nextTick(callback);
  INITED = true;
  ijod.initDB(function(err) {
    if (err) return callback(err);
    taskman.init(null, null, function(err) {
      if (err) return callback(err);
      acl.init(callback);
    });
  });
}

function doRetask(err, pids) {
  if (err) return logger.error('err', err);
  retask(pids, argv.concurrent, argv.force, function(err) {
    if (err) logger.error('err', err);
    logger.log('done');
    process.exit();
  });
}

init(function(err) {
  if (err) return logger.error('err', err);
  if (argv.gc) getOldsTaskPids(doRetask);
  else getPids(argv.offset, argv.limit, argv.service, doRetask);
});
