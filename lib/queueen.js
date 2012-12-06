var lconfig = require('lconfig');
var logger = require('logger').logger('queueen');
var redis;

var STANDARD_QUEUE = exports.STANDARD_QUEUE = 'next';
var PRIORITY_QUEUE = exports.PRIORITY_QUEUE = 'first';

exports.init = function(callback) {
  if (!lconfig.taskman.redis) {
    logger.error('lconfig.taskman.redis is required, exiting');
    process.exit(1);
  }
  redis = require('redis').createClient(
    lconfig.taskman.redis.port,
    lconfig.taskman.redis.host
  );
  redis.on('error', function (err) { logger.error('Redis Error', err); });
  redis.select(1, callback);
};

exports.enqueue = function(pid, priority) {
  return redis.sadd(priority || STANDARD_QUEUE, pid);
};

exports.dequeue = function(callback) {
  redis.spop(PRIORITY_QUEUE, function(err, pid) {
    if (err) return callback(err);
    if (pid) return callback(null, pid);
    redis.spop(STANDARD_QUEUE, callback);
  });
};

exports.remove = function(pid, priority) {
  // in case it got queued for any reason
  redis.srem(priority || STANDARD_QUEUE, pid);
};

exports.serviceCounts = function(callback) {
  var scount = {};
  redis.smembers(STANDARD_QUEUE, function(err, nexts) {
    if (err) return callback(err, nexts);
    if (nexts) nexts.forEach(function(pid){
      var svc = pid.split('@')[1];
      if (!scount[svc]) scount[svc] = 0;
      scount[svc]++;
    });
    logger.debug('scount', scount);
    callback(null, scount);
  });
};
