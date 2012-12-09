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

var lconfig = require('lconfig');
var logger = require('logger').logger('queenBee');
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
  if (priority && priority !== STANDARD_QUEUE) {
    logger.info('enqueueing %s with priority %s', pid, priority);
  }
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
