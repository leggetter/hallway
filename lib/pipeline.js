var async = require('async');
var logger = require('logger').logger("pipeline");
var lconfig = require('lconfig');
var path = require('path');
var fs = require('fs');
var dMap = require('dMap');
var IJOD = require('ijod');
var idr = require("idr");
var instruments = require("instruments");
var resolve = require('services/links/resolve');
var oembed = require('services/links/oembed');
var push = require('push');
var friends = require('friends');
var profileManager = require('profileManager');

// internal shared function to run the pipeline
function pumper(entries, services, auth, cbDone)
{
  if (entries.length === 0) return cbDone();
  var pipelineStart = Date.now();

  // XXX:  For now this is hardcoded, but it should be a bit more dynamically built based on the users apps
  // TODO: might be better to change the passed arg into a generic holder object, that hase the full changeset, broken out arrays by base, auth, etc
  var pumpingStations = [
    resolve.pump,
    oembed.pump,
    dMap.pump,
    friends.vpump,
    IJOD.pump,
    function(cset, cb) { friends.bump(cset, auth, cb); },
    function(cset, cb) { push.pump(cset, auth, cb); }
  ];

  function injector(cbInject) {
    logger.debug("Injecting %d entries", entries.length);
    // first prep load any possible maps (for app-based services)
    async.forEach(Object.keys(services), dMap.loadcheck, function(){
      cbInject(null, entries);
    });
  }
  var pumps = pumpingStations.slice(0);
  pumps.unshift(injector);
  // This final step is so we can do timing and other stats
  pumps.push(function(arg, cbStatsDone) {
    instruments.timing({"pipeline.run":(Date.now() - pipelineStart)}).send();
    process.nextTick(function() {
      cbStatsDone(null, arg);
    });
  });
  var timings = [];
  pumps = wrapPumps(timings, pumps);
  async.waterfall(pumps, function(err) {
    timings.shift();
    cbDone(err, timings);
  });
}

function wrapPumps(timings, pumps) {
  var newPumps = [];
  var start = Date.now();
  pumps.forEach(function(pump) {
    newPumps.push(function(cset, cb) {
      timings.push(Date.now() - start);
      start = Date.now();
      return pump(cset, cb);
    });
  });
  return newPumps;
}

// util to save data to a specific account via the pipeline
exports.account = function(id, app, entries, cbDone)
{
  if(!id || !app || !entries || entries.length === 0) return cbDone("invalid args");
  var pid = [id, app].join('@');

  // fetch the OPTIONAL auth object, we're ignoring the error since often the pid is account@app and there is no auth for it, but yet we're saving custom data
  profileManager.authGet(pid, app, function(err, auth){
    if(!auth) { // we need to spoof a blank one here for the push pump when there isn't any like per-app-account custom data
      auth = {apps:{}};
      auth.apps[app] = {accounts:{}};
      auth.apps[app].accounts[id] = true;
      auth.pid = pid;
    }
    pumper(entries, [app], auth, function(err){
      cbDone(err, entries);
    });
  });
};

// injector used by synmanager to take raw synclet return data and massage it
exports.inject = function(arg, auth, cbDone) {
  if(!arg) return cbDone();
  if (typeof(arg) !== "object") {
    logger.debug(arg);
    return cbDone("arg is not a keyed synclet result");
  }

  var entries = [];
  var services = {};
  Object.keys(arg).forEach(function(base) {
    if(!Array.isArray(arg[base]))
    {
      logger.warn("got wrong type",typeof arg[base]);
      return;
    }
    var baseIdr = idr.base(base);
    services[baseIdr.host] = true;
    var delayc = 0;
    var delayt = 0;
    var keyCount = 0;
    var metric = {};
    arg[base].forEach(function(entry) {
      var entryIdr = idr.clone(baseIdr);
      var entryId = dMap.get("id", entry, base);
      if (!entryId) {
        logger.error("Could not get an id from the entry: %j "+base, entry);
        return;
      }
      entryId = entryId.toString(); // ensure always a string
      entryIdr.hash = entryId;
      var at = dMap.get("at", entry, base);
      // use the created timestamp from the raw data if any
      if(at) { // track for overall delay monitoring
        delayc++;
        delayt += Date.now() - at;
      } else {
        at = Date.now();
      }
      ++keyCount;
      entries.push({idr:entryIdr, id:idr.hash(entryIdr), data:entry, at:at});
      var instrumentKey = "data.services." + baseIdr.host + "." + entryIdr.path.substring(1);
      if (metric[instrumentKey] === undefined) metric[instrumentKey] = 0;
      ++metric[instrumentKey];
    });
    instruments.modify(metric).send();
  });

  pumper(entries, services, auth, cbDone);
};
