var fs = require('fs');
var path = require('path');
var async = require('async');
var lconfig = require('lconfig');
var util = require('util');
var logger = require('logger').logger('taskman');
var profileManager = require('profileManager');
var dal = require('dal');
var idrlib = require('idr');
var ijod = require('ijod');
var instruments = require('instruments');
var pipeline = require('pipeline');
var acl = require('acl');
var locksmith = require('locksmith');
var taskStore = require('taskStore');
var servezas = require('servezas');
var redis;

var WORKER_NAME = process.env.WORKER || require("os").hostname();
var NUM_WORKERS = lconfig.taskman.numWorkers || 4;
var DEFAULT_SCAN_TIME = lconfig.taskman.defaultScanTime || 30000;
// when a task is considered stale for freshness support
var STALE_TIME = lconfig.taskman.staleTime || 600000;
 // how many tasks do we grab per scan
var SCAN_CHUNK = lconfig.taskman.scanChunk || 100;
// max runtime for any task
var TASK_TIMEOUT = lconfig.taskman.timeout || 240000;
// how far into the future to run any upcoming tasks
var TASK_GLOB = 60000;
// if it's error'd the last two times, when to try again
var TASK_ERRDELAY = 43200000;


// to only run tasks for one profile
var ONE_PROFILE = false;

var STOP_WHEN_IDLE = false;

var STATS = {total:0, last:[], tasks:0};
var WORKERS = {};
var TIMERS = {};

// the live flag makes this start doing work :)
exports.init = function(pid, live, stopWhenIdle, callback) {
  if (!lconfig.taskman.redis) {
    logger.error('lconfig.taskman.redis is required, exiting');
    process.exit(1);
  }
  redis = require('redis').createClient(
    lconfig.taskman.redis.port,
    lconfig.taskman.redis.host
  );
  redis.on("error", function (err) { logger.error("Redis Error",err); });

  if (pid) {
    ONE_PROFILE = pid;
    logger.info("locking in to",pid);
  }

  if (stopWhenIdle && process.NODE_ENV !== 'production') {
    STOP_WHEN_IDLE = true;
    logger.warn('testing/debug only! stopping when idle!!!');
  }
  logger.info('DEFAULT_SCAN_TIME', DEFAULT_SCAN_TIME);
  logger.info('SCAN_CHUNK', SCAN_CHUNK);
  logger.info('NUM_WORKERS', NUM_WORKERS);

  servezas.load(function() {
    // we're init'd once we've selected our redis db
    redis.select(1, function() {
      locksmith.init(WORKER_NAME, ONE_PROFILE);
      // start threads!
      if (live) {
        TIMERS.check = setInterval(checkNext, lconfig.taskman.pagingTiming);
        fillNext();
      }
      callback();
    });
  });
};

exports.stop = function(callback) {
  clearInterval(TIMERS.check);
  clearInterval(TIMERS.fill);
  if (STATS.stopped) return callback();
  STATS.stopped = true;
  if (Object.keys(WORKERS).length === 0) return callback();

  // try to kill each worker thread
  Object.keys(WORKERS).forEach(function(worker) {
    worker.killed = true;
  });
  // check again in 10sec to force kill
  setTimeout(function() {exports.stop(callback);}, 10000);
};

exports.stats = function() {
  STATS.workers = WORKERS;
  return STATS;
};

// trigger any profile to sync asap
exports.syncNow = function(pid, synclet, callback) {
  logger.debug("force sync",pid,synclet);
  // TODO do we poll-wait for tasks to be updated to callback()??
  // if synclet, fetch/update task at to now
  redis.sadd("next",pid);
  callback();
};

// just raw tally to estimate
exports.backlog = function (callback) {
  var total = 0;
  var oldest = Date.now();
  var bases = {};

  async.forEachSeries(servezas.serviceList(), function (service, cbSvcLoop) {
    async.forEachLimit(servezas.syncletList(service), 10,
      function (synclet, cbSyncLoop) {
      var base = 'task:' + service + '/' + synclet;

      ijod.getBounds(base, { until: Date.now() }, function (err, bounds) {
        if (err) logger.warn(err, base);

        if (bounds) {
          if (bounds.total) total += bounds.total;

          if (bounds.oldest && bounds.oldest < oldest) {
            oldest = bounds.oldest;
          }

          bases[base] = bounds;
        }

        cbSyncLoop();
      });
    }, cbSvcLoop);
  }, function () {
    callback({ total: total, oldest: oldest, bases: bases });
  });
};

// force run everything for a pid right now
exports.syncForce = function(pid, callback) {
  logger.debug("force running",pid);
  runWorker(pid, callback, true);
};

var checkTimer = undefined;
// try to pop a new task off the general redis next queue
function checkNext() {
  clearTimeout(checkTimer);
  checkTimer = undefined;
  // bail if already max busy
  if (Object.keys(WORKERS).length > NUM_WORKERS) return;
  // logger.debug("checking for any next work");
  redis.spop("next", function(err, pid) {
    if (!pid) return;
    locksmith.isLocked(pid, function(locked) {
      if (locked) return;
      runWorker(pid, function() {
        // if a worker finished, look for more work asap!
        if (checkTimer === undefined) {
          checkTimer = setTimeout(checkNext, 1000);
        }
      });
    });
  });
}

// scan due or soon-to-be-due tasks for profiles to get busy with, must only be
// run every 10s
function fillNext() {
  if (STATS.shutdown) return;
  logger.debug("fillNext looking");
  var scount = {};
  // count what is in the redis next queue
  redis.smembers("next", function(err, nexts){
    if (err) throw err;
    if (nexts) nexts.forEach(function(pid){
      var svc = pid.split('@')[1];
      if (!scount[svc]) scount[svc] = 0;
      scount[svc]++;
    });
    logger.debug('scount', scount);
    fillNextScan(scount);
  });
}

// actually scan ijod for pids that have tasks that are behind
function fillNextScan(scount) {
  var pids = {};
  var start = Date.now();
  async.forEachSeries(servezas.serviceList(), function(service, cbSvcLoop) {
    // if this service is already active don't scan for more
    if (scount[service] && scount[service] > SCAN_CHUNK) {
      logger.info('already have %d pids queued for %s, skipping',
        scount[service], service);
      return process.nextTick(cbSvcLoop);
    }

    async.forEach(servezas.syncletList(service), function(synclet, cbSyncLoop) {
      // just get the X oldest... maybe use special db-only to get list of idrs
      // and getOne each would be faster?
      ijod.getRange('task:' + service + '/' + synclet, {
        until: Date.now(),
        reverse: true,
        limit: SCAN_CHUNK
      }, function(task) {
        if (ONE_PROFILE && task.pid !== ONE_PROFILE) return;
        //logger.debug('aged task',task.idr,task.at);
        pids[task.pid] = true;
      }, cbSyncLoop);
    }, cbSvcLoop);
  }, function() {
    var plist = Object.keys(pids);
    logger.info("fillNext took",
      parseInt((Date.now() - start)/1000, 10),
      plist.length
    );
    if (plist.length === 0) {
      if (Object.keys(WORKERS).length === 0 && STOP_WHEN_IDLE) {
        logger.warn('idle');
        exports.stop(function() {
          logger.warn('went idle, shutting down');
          process.exit(0);
        });
      }
      return setTimeout(fillNext, DEFAULT_SCAN_TIME);
    }

    // we've got tasks! gotta async this so that the workers have a cycle to
    // start up and be tracked
    var nexted = [];
    async.forEachSeries(plist, function(pid, cbLoop) {
      if (Object.keys(WORKERS).length > NUM_WORKERS) {
        // dump into next queue for others if already max busy
        redis.sadd("next", pid);
        nexted.push(pid);
        return process.nextTick(cbLoop);
      }
      locksmith.isLocked(pid, function(locked) {
        if (!locked) runWorker(pid, function() {});
        cbLoop();
      });
    }, function() {
      logger.info("nexted ",nexted.join(" "));
      setTimeout(fillNext, DEFAULT_SCAN_TIME);
    });
  });
}

// I'm hating the logic in this function, it def needs a refactor
exports.taskUpdate = function(auth, callback, force) {
  if (!auth.pid) {
    logger.warn("invalid auth, missing pid",auth);
    return process.nextTick(callback.bind(null, new Error("auth missing pid")));
  }
  var service = auth.pid.split('@')[1];
  if (!servezas.synclets(service)) {
    return process.nextTick(callback.bind(null, new Error("unknown service")));
  }

  taskStore.reconcileTasks(auth, force, function(err, added) {
    if (err) return callback(err);
    // if there's new tasks, queue them up asap
    if (added) redis.sadd("next", auth.pid);
    callback();
  });
};
// perform all possible tasks for this pid
function runWorker(pid, callback, force) {
  if (WORKERS[pid]) return callback(new Error("already running"));
  if (STATS.stopped) return callback(new Error("shutting down"));

  // our process-wide tracking
  var self = WORKERS[pid] = {
    pid     : pid,
    tasks   : [],
    started : Date.now(),
    total   : 0,
    killed  : false
  };
  self.service = pid.split('@')[1];

  // safety cleanup
  function cbDone(err, tasks) {
    if (err) logger.error("runWorker error for pid " + pid, err);
    logger.debug("worker done",pid);
    clearInterval(self.hbtimer);
    redis.srem("next", pid); // in case it got queued for any reason
    locksmith.clearLock(pid, function() {
      delete WORKERS[pid];
      callback(err, tasks);
    });
  }

  // handy cb wrapper
  function tasksNow(cbTasks) {
    // if given a list of tasks already, use and force run them
    if (typeof force === 'object') return cbTasks(undefined, force);
    taskStore.getTasks(pid, cbTasks);
  }

  // first! acquire pid lock
  locksmith.requestLock(pid,function(err, set) {
    if (err || set === 0) return cbDone(new Error("failed to acquire lock"));
    // sometimes it got queued again, doesn't need to be now
    redis.srem("next", pid);

    // validate and freshen our lock to heartbeat and stay alive
    self.hbtimer = setInterval(function() {
      logger.debug("heartbeating", pid);
      locksmith.heartbeat(pid, function(err) {
        if (err) return self.killed = err;
      });
    }, locksmith.LOCK_TIMEOUT / 2);

    // get the auth+config needed to run any task
    logger.debug("worker startup looking for tasks", pid);
    profileManager.allGet(pid, function(err, pi) {
      // ugly, but have to fetch all possible synclets (TODO are a bunch of
      // getOnes faster than a forced db range query on a set of idrs and
      // base+timestamp? or use redis to collect them?)
      tasksNow(function(err, tasks) {
        if (err) logger.error('error getting tasks ' + JSON.stringify(err));
        if (!tasks) return cbDone('no tasks found');
        logger.info("scanning tasks", Object.keys(tasks).map(function(id) {
          return [id,tasks[id].at - Date.now()].join(" ");
        }).join(" "));

        // if somehow this is removed, dump the tasks!
        if (!pi || typeof pi.auth !== "object") {
          return async.forEach(Object.keys(tasks), function(taskid, cbLoop) {
            logger.warn("missing profile info, removing task",taskid);
            ijod.delOne(taskid, function() { cbLoop(); });
          }, function() {
            return cbDone(new Error("missing profile info"));
          });
        }
        if (!pi.config) pi.config = {};

        // figure out which ones we're doing based on their .at being near to
        // now
        var todo = [];
        var glob = Date.now();
        glob += TASK_GLOB; // set into the future
        async.forEach(Object.keys(tasks), function(taskid, cbLoop) {
          if (!force && tasks[taskid].at > glob) {
            return process.nextTick(cbLoop);
          }
          todo.push(tasks[taskid]);
          // when being force run don't stage them forward
          if (force) return process.nextTick(cbLoop);
          // also save it into the future a bit so it stays out of the
          // filler and in case this all goes bust it'll come back again
          tasks[taskid].nextRun = 300000; // 5 minutes into the future
          tasks[taskid].queued = Date.now();
          tasks[taskid].worker = WORKER_NAME;
          taskStore.saveTask(tasks[taskid], cbLoop);
        }, function() {
          if (todo.length === 0) {
            logger.warn("no tasks found to do!", pid,
              Object.keys(tasks).map(function(id) {
                return [id, tasks[id].at].join(" ");
              }).join(" "));

            return cbDone();
          }

          self.tasks = todo;
          if (!(pi && pi.auth && pi.auth.pid)) {
            return cbDone('No pid in pi ' + JSON.stringify(pi));
          }

          var loop = doTasksInSeries;
          // sandboxed task run in parallel
          if (servezas.isSandboxed(self.service)) loop = doTasksInParallel;

          return loop(todo, self, pi, cbDone);
        });
      });
    });
  });
}

function doTasksInSeries(todo, self, pi, cbDone) {
  logger.debug('working doing tasks in series', todo.length);
  async.forEachSeries(todo, function(task, cbLoop) {
    if (self.killed) return process.nextTick(cbLoop);
    var piCopy = JSON.parse(JSON.stringify(pi));
    runTask(piCopy, task, function(err, config) {
      if (err) return cbLoop(err);
      updateConfig(config, pi.auth.pid, cbLoop);
    });
  }, function(err) {
    // release locks and return
    cbDone(err, self);
  });
}

function doTasksInParallel(todo, self, pi, cbDone) {
  logger.debug('working doing tasks in parallel', todo.length);
  // collect configs and then save them all in series so we can run
  // the tasks in parallel without worrying about race conditions
  // there is definitely a better way to do this, but this works consistently
  // for now
  var configUpdates = [];
  async.forEach(todo, function(task, cbLoop) {
    if (self.killed) return process.nextTick(cbLoop);
    var piCopy = JSON.parse(JSON.stringify(pi));
    runTask(piCopy, task, function(err, config) {
      if (err) return cbLoop(err);
      if (config) configUpdates.push(config);
      cbLoop();
    });
  }, function() {

    // update the configs in series to avoid an insert race condition
    async.forEachSeries(configUpdates, function(configUpdate, cbLoop) {
      updateConfig(configUpdate, pi.auth.pid, cbLoop);
    }, function(err) {
      if (err) {
        logger.error('error updating config - pid:' + pi.auth.pid +
                     ', config:', configUpdates);
      }
      // release locks and return
      cbDone(null, self);
    });
  });
}

function updateConfig(configUpdate, pid, cb) {
  if (!configUpdate) return process.nextTick(cb);
  // auth info is rarely updated, must save it if so, can happen async
  if (configUpdate && configUpdate._auth) {
    return profileManager.authSet(pid, configUpdate._auth, false, function(err) {
      if (err) logger.warn(err);
      delete configUpdate._auth;
      profileManager.configSet(pid, configUpdate, cb);
    });
  }

  profileManager.configSet(pid, configUpdate, cb);
}

// perform the synclet and pipeline, saving state at the end
function runTask(pi, task, fnCallback) {
  if (!pi || !task) {
    logger.warn("runtask invalid args", typeof pi, typeof task);
    return fnCallback();
  }

  var sandboxed = servezas.isSandboxed(task.service);
  // if it's sandboxed, just pass in this synclet's config
  if (sandboxed) {
    pi.all = pi.config || {};
    pi.config = pi.config[task.synclet] || {};
  }

  logger.debug("running task", task.idr);

  task.tstart = Date.now();

  // be fucking paranoid about not double-callbacks
  var done = false;

  var timer = setTimeout(function() {
    cbDone("forced timeout");
  }, TASK_TIMEOUT);

  // all the post-processing of a synclet run, skip below where it runs
  function cbDone(err, response) {
    clearTimeout(timer);

    if (done) {
      return logger.warn("DOUBLE CALLBACK IS BAD", task.idr);
    }

    done = true;

    // easier to have this as the default
    response = response || {};

    if (err) {
      logger.warn(
        task.idr,
        "sync error",
        util.inspect(err).replace(/\s+/g, " ")
      );
    }

    var lasterr = task.err;
    task.err = err;

    // flag it's done, then send it out and be done
    task.tpipe = Date.now();
    task.count = countObjectsReturned(response);

    logger.verbose("Synclet finished",
        task.idr, "in", task.tpipe - task.tstart, "ms");

    // if config updated, sanitize it
    if (response.config && response.config.nextRun) {
      task.nextRun = response.config.nextRun;
      delete response.config.nextRun;
    }

    // pass back the updated config, which will be saved by the parent function
    // save a pointer here, because response obj get modified along the way
    var cfg = response.config;
    var callback = function(err) {
      var configUpdate = cfg;
      // if it is sandboxed, namespace it to this synclet's name
      if (sandboxed) {
        configUpdate = {};
        configUpdate[task.synclet] = cfg;
        // move the _auth object to the top level
        if (cfg && cfg._auth) {
          configUpdate._auth = cfg._auth;
          delete cfg._auth;
        }
      }
      fnCallback(err, configUpdate);
    };

    STATS.total += task.count;
    STATS.tasks++;

    // if there's an error and no data, bail, but we process data even during an
    // error since some synclets return them as a warning or where they got
    // stuck
    if (task.err && task.count === 0) {
      var syncletError = "synclet.error." + task.service + "." + task.synclet;
      instruments.increment(syncletError).send();
      if (lasterr) task.nextRun = TASK_ERRDELAY;
      return taskStore.saveTask(task, callback);
    }

    updateTolerance(task);

    // if any auth updates, merge+flag it
    if (typeof response.auth === 'object') {
      if (!cfg) cfg = {};
      cfg._auth = {};

      Object.keys(response.auth).forEach(function(key) {
        cfg._auth[key] = response.auth[key];
      });
    }

    // if no data to process, shortcut
    if (task.count === 0) {
      return taskStore.saveTask(task, callback);
    }

    task.tpipe = Date.now();

    // run it through the pipeline! if there is an updated auth object, us it
    var auth = (cfg && cfg._auth) || pi.auth;
    pipeline.inject(response.data, auth, function(err, timings) {
      // when we can't save, capture that state, but bail fast
      if (err) {
        task.err = err;
        logger.warn("pipeline failed to save task data",task.idr,err);
        return taskStore.saveTask(task, callback);
      }

      task.tdone = Date.now();

      logger.verbose("Pipeline finished",
        task.idr, "in", task.tdone - task.tstart, "ms");

      sendStats(task, timings);

      // party time
      taskStore.saveTask(task, callback);
    });
  }

  // time to run the synclet :)
  instruments.increment("synclet.run").send();
  instruments.increment("synclet.runs." + task.service + "." + task.synclet).send();

  // In case something in the synclet immediately barfs...
  try {
    servezas.synclet(task.service, task.synclet).sync(pi, cbDone);
  } catch(E) {
    cbDone(E);
  }
}

function countObjectsReturned(response) {
  var count = 0;
  // ugly but counts the total items being processed for admin/debug
  if (typeof response.data === 'object') {
    Object.keys(response.data).forEach(function(key) {
      if (Array.isArray(response.data[key])) {
        count += response.data[key].length;
      }
    });
  }
  return count;
}

function updateTolerance(task) {
  var average = 0;

  // Update our tolerance info
  if (task.tolerance.averages.length > 5) {
    task.tolerance.averages.forEach(function(avg) {
      average += avg;
    });

    average /= task.tolerance.averages.length;
  } else {
    // Until we have enough to get an idea of what they are moving, we're
    // using an old threshold
    average = 50;
  }

  logger.debug("Average for tolerance is %d", average);

  if (task.count > average * 1.1) {
    // We're over the average, let's bump the tolerance down so we run more
    task.tolerance.current--;

    if (task.tolerance.current < 0) {
      task.tolerance.current = 0;
    }
  } else if (task.count === 0 || task.count <= average * 0.90) {
    // We got too little data, we can wait a bit longer
    task.tolerance.current = Math.min(++task.tolerance.current, 500);
  }

  task.tolerance.averages.push(task.count);

  if (task.tolerance.averages.length > 10) {
    task.tolerance.averages.shift();
  }
}

function sendStats(task, timings) {
  // Log a gauge of the # of items returned by the synclet by service and name
  var stats = {};

  var servicesPrefix = "synclet.items.services.";
  stats[servicesPrefix + "rollup"] = task.count;
  stats[servicesPrefix + task.service + ".rollup"] = task.count;
  stats[servicesPrefix + task.service + "." + task.synclet] = task.count;

  instruments.modify(stats).send();

  instruments.increment("synclet.successful").send();

  // Log the duration of the synclet by service and name
  stats = {};

  var syncletDuration = task.tpipe - task.tstart;
  var pipelineDuration = task.tdone - task.tpipe;

  var syncDurationPrefix = "synclet.duration." + task.service;
  stats["synclet.duration.rollup"] = syncletDuration;
  stats[syncDurationPrefix + ".rollup"] = syncletDuration;
  stats[syncDurationPrefix + "." + task.synclet] = syncletDuration;

  var pipeDurationPrefix = "pipeline.duration." + task.service;
  stats["pipeline.duration.rollup"] = pipelineDuration;
  stats[pipeDurationPrefix + ".rollup"] = pipelineDuration;
  stats[pipeDurationPrefix + "." + task.synclet] = pipelineDuration;

  instruments.timing(stats).send();

  // Log at 60 seconds
  if (syncletDuration > 60000 ||
    pipelineDuration > 60000) {
    logger.info("Synclet " + task.service + "#" + task.synclet +
      " took > 60s to complete: " +
      Math.round(syncletDuration / 1000) + "s synclet, " +
      Math.round(pipelineDuration / 1000) + "s pipeline, " +
      "pipeline breakout:", timings);
  }

  // keep the last 100 tasks around for admin
  STATS.last.unshift(task);
  STATS.last = STATS.last.slice(0, 100);
}


// optionally run a base here if needed
exports.fresh = function(base, callback) {
  if (!base) return callback();
  var r = idrlib.parse(base);
  var service = r.host;
  var endpoint = r.path;
  var synclets = servezas.synclets(service);
  if (!r.host || !synclets) {
    return callback(new Error("invalid service " + service));
  }
  var pid = [encodeURIComponent(r.auth),r.host].join('@');

  // have to find out which synclets matched
  var matched = {};
  Object.keys(synclets).forEach(function(sname){
    var data = synclets[sname].data;
    if (sname === endpoint) {
      // if there is a freshInstead value, run that instead
      if (data.freshInstead) matched[data.freshInstead] = true;
      else matched[sname] = true;
    }
    if (data.aka && data.aka.indexOf(endpoint) >= 0) matched[sname] = true;
  });

  // now get all of those tasks and see if they've become stale
  freshenUp(Object.keys(matched), service, pid, callback);
};

// runs a set of synclets if they are older than STALE_TIME
function freshenUp(synclets, service, pid, callback) {
  var tasks = {};
  async.forEach(synclets, function(synclet, cbLoop) {
    var taskIDR = 'task:' + service + '/' + synclet + '#' + pid;
    ijod.getOne(taskIDR, function(err, task) {
      if (err) {
        return callback(err);
      }
      // if task is older than stale time, or always allow freshening up self
      var stale = task && (Date.now() - task.saved > STALE_TIME);
      if (stale || synclet === 'self') tasks[task.idr] = task;
      cbLoop();
    });
  }, function() {
    locksmith.isLocked(pid, function(locked){ // this will clear stale locks too
      if (locked) return callback("currently running");
      logger.info("fresh running ",Object.keys(tasks));
      runWorker(pid, callback, tasks);
    });
  });
}
