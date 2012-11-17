var express = require('express');
var connect = require('connect');
var logger = require('logger').logger('worker');
var taskman = require('taskman');
var ijod = require('ijod');
var lconfig = require('lconfig');
var lutil = require('lutil');
var dal = require('dal');
var os = require('os');

var tstarted;

var VERSION = 'Unknown';
var CONFIG_VERSION = 'Unknown';

var worker = express.createServer(
  connect.bodyParser(),
  connect.cookieParser()
);

worker.get('/', function(req, res) {
  var cnt = 0;
  var tot = 0;

  taskman.stats().last.forEach(function(task) {
    cnt++;
    tot += (task.tdone - task.tstart);
  });

  var ret = {
    version: VERSION,
    configVersion: CONFIG_VERSION,
    active: Object.keys(taskman.stats().workers).length,
    total: taskman.stats().tasks,
    entries: taskman.stats().total,
    host: require("os").hostname(),
    runtime: (tot / cnt) / 1000,
    uptime: Math.floor((Date.now() - tstarted) / 1000),
    os: {
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem()
    },
    workers: taskman.stats().workers
  };

  res.json(ret);
});

// public health check
worker.get('/enoch', function(req, res) {
  var good = req.query['true'] || true;
  var bad = req.query['false'] || false;
  if(req.query.fail) return res.json(bad, 500);
  dal.query('select true', [], function(err, row) {
    if(err) return res.json(bad, 500);
    if(!row || !row[0] || row[0].TRUE !== '1') return res.json(bad, 500);
    res.json(good);
  });
});

// force run a pid
worker.get('/run/:pid', function(req, res) {
  taskman.syncForce(req.params.pid, function(err, tasks){
    if(err) return res.json(err, 500);
    res.json(tasks||{});
  });
});

// quick peak at global backlog
worker.get('/backlog', function(req, res) {
  taskman.backlog(function(data){
    res.json(data);
  });
});

// error handling
worker.error(function(err, req, res, next) {
  if(err.stack) logger.error(err.stack);
  res.json(err, 500);
});

exports.startService = function(port, ip, cb) {
  tstarted = Date.now();

  lutil.hashFile(__dirname + '/../Config/config.json', function (err, hash) {
    if (err) {
      return;
    }

    CONFIG_VERSION = hash;
  });

  lutil.currentRevision(function(err, hash) {
    VERSION = hash;
  });

  worker.listen(port, ip, function() {
    logger.info('Worker status is now listening at ' + ip + ':' + port);

    cb(worker);
  });
};
