var connect = require('connect');
var express = require('express');

var dal = require('dal');
var hostStatus = require('host-status').status;
var logger = require('logger').logger('worker');
var taskman = require('taskman');

var worker = express.createServer(
  connect.bodyParser(),
  connect.cookieParser()
);

worker.get('/', function (req, res) {
  var ret = hostStatus();

  var cnt = 0;
  var tot = 0;

  var taskmanStats = taskman.stats();

  taskmanStats.last.forEach(function (task) {
    cnt++;

    tot += (task.tdone - task.tstart);
  });

  ret.runtime = (tot / cnt) / 1000;

  ret.entries = taskmanStats.total;
  ret.workers = taskmanStats.workers;
  ret.total = taskmanStats.tasks;
  ret.active = Object.keys(taskmanStats.workers).length;

  res.json(ret);
});

// public health check
worker.get('/enoch', function (req, res) {
  var good = req.query['true'] || true;
  var bad = req.query['false'] || false;
  if (req.query.fail) return res.json(bad, 500);
  dal.query('select true', [], function (err, row) {
    if (err) return res.json(bad, 500);
    if (!row || !row[0] || row[0].TRUE !== '1') return res.json(bad, 500);
    res.json(good);
  });
});

// force run a pid
worker.get('/run/:pid', function (req, res) {
  taskman.syncForce(req.params.pid, function (err, tasks) {
    if (err) return res.json(err, 500);
    res.json(tasks || {});
  });
});

// quick peak at global backlog
worker.get('/backlog', function (req, res) {
  taskman.backlog(function (data) {
    res.json(data);
  });
});

// error handling
worker.error(function (err, req, res) {
  if (err.stack) logger.error(err.stack);
  res.json(err, 500);
});

exports.startService = function (port, ip, cb) {
  worker.listen(port, ip, function () {
    logger.info('Worker status is now listening at ' + ip + ':' + port);

    cb(worker);
  });
};
