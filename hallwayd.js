/*
 *
 * Copyright (C) 2011, The Locker Project
 * All rights reserved.
 *
 * Please see the LICENSE file for more information.
 *
 */

exports.alive = false;

var async = require('async');
var util = require('util');
var argv = require('optimist').argv;

// lconfig has to be loaded before any other hallway modules!
var lconfig = require('lconfig');

var instruments = require('instruments');
var logger = require('logger').logger('hallwayd');

logger.info('process id:' + process.pid);

var taskman = require('taskman');
var profileManager = require('profileManager');
var taskmaster = require('taskmaster');

var http = require('http');

// Set our globalAgent sockets higher
http.globalAgent.maxSockets = 800;

function startAPIHost(cbDone) {
  logger.info("Starting an API host");

  var webservice = require('webservice');

  webservice.startService(lconfig.lockerPort, lconfig.lockerListenIP,
    function (hallway) {
    logger.info('Hallway is now listening at ' + lconfig.lockerBase);

    cbDone();
  });
}

function startDawg(cbDone) {
  if (!lconfig.dawg || !lconfig.dawg.port || !lconfig.dawg.password) {
    logger.error("You must specify a dawg section with at least a port and " +
      "password to run.");

    process.exit(1);
  }

  logger.info("Starting a Hallway Dawg -- Think you can get away without " +
    "having a hall pass?  Think again.");

  var dawg = require('dawg');

  dawg.startService(lconfig.dawg.port, lconfig.dawg.listenIP, function() {
    logger.info("The Dawg is now monitoring at port %d", lconfig.dawg.port);

    cbDone();
  });
}

function startStream(cbDone) {
  logger.info("Starting a Hallway Stream -- you're in for a good time.");

  require('streamer').startService(lconfig.stream, function() {
    logger.info("Streaming at port %d", lconfig.stream.port);

    cbDone();
  });
}

function startWorkerWS(cbDone) {
  if (!lconfig.worker || !lconfig.worker.port) {
    logger.error("You must specify a worker section with at least a port and " +
      "password to run.");
    process.exit(1);
  }
  var worker = require("worker");
  if (!lconfig.worker.listenIP) lconfig.worker.listenIP = "0.0.0.0";
  worker.startService(lconfig.worker.port, lconfig.worker.listenIP, function() {
    logger.info("Starting a Hallway Worker, thou shalt be digitized",
      lconfig.worker);
    cbDone();
  });
}

function startTaskmaster(cbDone) {
  if (!lconfig.taskmaster || !lconfig.taskmaster.port) {
    logger.error("You must specify a taskmaster section with at least a port and password to run.");
    process.exit(1);
  }
  var worker = require("worker"); // reuse this for now, common things should be refactored someday
  if (!lconfig.taskmaster.listenIP) lconfig.taskmaster.listenIP = "0.0.0.0";
  worker.startService(lconfig.taskmaster.port, lconfig.taskmaster.listenIP, function() {
    taskmaster.init(function(){
      logger.info("Started a Hallway Taskmaster, world re-mastered!", lconfig.taskmaster);
      cbDone();      
    });
  });
}

var Roles = {
  taskmaster: {
    startup: startTaskmaster
  },
  worker: {
    startup: startWorkerWS
  },
  apihost: {
    startup: startAPIHost
  },
  dawg: {
    startup: startDawg
  },
  stream: {
    startup: startStream
  }
};

var role = Roles.apihost;

function startTaskman(cbDone) {
  var isWorker = (role === Roles.worker);
  if (isWorker) logger.info("Starting a worker.");
  taskman.init(isWorker, argv.once, cbDone);
}

if (argv._.length > 0) {
  if (!Roles.hasOwnProperty(argv._[0])) {
    logger.error("The %s role is unknown.", argv._[0]);

    return process.exit(1);
  }

  role = Roles[argv._[0]];
}

var startupTasks = [];

if (role !== Roles.stream) {
  // this loads all lib/services/*/map.js
  startupTasks.push(require('dMap').startup);
  startupTasks.push(require('ijod').initDB);
  startupTasks.push(require('tokenz').init);
  startupTasks.push(startTaskman);
}

if (role !== Roles.dawg && role !== Roles.stream) {
  startupTasks.push(require('acl').init);
  startupTasks.push(profileManager.init);
}

if (role.startup) {
  startupTasks.push(role.startup);
}

async.series(startupTasks, function(error) {
  // TODO:  This needs a cleanup, it's too async
  logger.info("Hallway is up and running.");

  exports.alive = true;
});

process.on("SIGINT", function() {
  logger.info("Shutting down via SIGINT...");

  switch (role) {
    case Roles.worker:
      taskman.stop(function() {
        process.exit(0);
      });
      break;
    case Roles.apihost:
      process.exit(0);
      break;
    default:
      process.exit(0);
      break;
  }
});

process.on("SIGTERM", function () {
  logger.info("Shutting down via SIGTERM...");
  process.exit(0);
});

process.on('uncaughtException', function (err) {

  logger.warn('Uncaught exception: ' + err.stack);

  instruments.increment('exceptions.uncaught').send();

  // For any role OTHER than taskmaster, we try to ignore "innocous"
  // errors. This is a temporary fix until we can track down source.
  // TODO: Track down any/all root causes so we can get rid
  // of this hack
  if (role !== Roles.taskmaster) {
    // Check for errors we are comfortable (!!) ignoring
    var ignoredErrors = ["Error: Parse Error", // see: https://github.com/joyent/node/issues/2997
                         "ECONNRESET",
                         "socket hangup",
                         "ETIMEDOUT",
                         "EADDRINFO"];
    var errString = err.toString();
    for (var msg in ignoredErrors) {
      if (errString.indexOf(ignoredErrors[msg]) >= 0) {
        logger.warn("Ignored exception: ", ignoredErrors[msg]);
        instruments.increment('exceptions.ignored').send();
        return;
      }
    }
  }

  // None of the errors we know about -- shutdown
  process.exit(1);
});

