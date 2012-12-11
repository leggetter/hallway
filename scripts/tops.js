var request = require('request');
var async = require('async');
var argv = require('optimist')
    ['default']('hours', 24)
    ['default']('host', 'https://dawg.singly.com')
    .demand(['auth', 'app-id'])
    .usage('node scripts/tops.js --auth dawguser:dawgpass --app-id appid')
    .argv;

var req = {
  url: argv.host + '/apps/logs',
  qs: {
    key:argv['app-id'],
    limit:100,
    offset:0
  },
  headers: {
   Authorization:"Basic " + new Buffer(argv.auth).toString("base64")
  },
  json: true
};
var until = Date.now() - (3600*argv.hours*1000);
var accounts = {};
var actprofile = {};

var log = console.log;
var error = console.error;

log('<table><tr>');
log('<td>Account</td><td>Hits</td><td>Name</td><td>Social Prof</td><td>Loc</td><td>Email</td>');
log('</tr>');

step(function() {
  async.forEachLimit(Object.keys(accounts), 10, function(act, cbAct) {
    request.get({url: argv.host + '/proxy/'+act+'/profile',
      headers:req.headers, json:true}, function(err, resp, profile) {
      if (err) error('failed to proxy for profile', err);
      actprofile[act] = profile || {};
      cbAct();
    });
  }, function() {
    var acts = Object.keys(accounts);
    acts.sort(function(a,b){ return accounts[b] - accounts[a]; });
    acts.forEach(function(id) {
      logRow(id, accounts[id], actprofile[id]);
    });
    log('</table>');
  });
});

function logRow(id, count, profile) {
  var line = '<tr>';
  line += '<td><a href="https://dawg.singly.com/apps/account?id='+id+'">' +
    id.substring(0, 6) + '</a></td>';
  line += '<td>'+count+'</td>';
  line += '<td>'+(profile.name||'&nbsp;')+'</td>';
  line += '<td><a href="'+profile.url+'">' + profile.handle + '</a></td>';
  line += '<td>'+(profile.location||'&nbsp;')+'</td>';
  line += '<td>'+(profile.email||'&nbsp;')+'</td>';
  line += '</tr>';
  log(line);
}

function step(cb) {
  request.get(req, function(err, res, logs) {
    if(err || !Array.isArray(logs)) return cb();
    var older = false;
    logs.forEach(function(log) {
      if(log.at < until) older = true;
      if(!Array.isArray(log.data)) return;
      log.data.forEach(function(hit) {
        if(!hit.act || hit.act === 'auth') return;
        if(!accounts[hit.act]) accounts[hit.act] = 0;
        accounts[hit.act]++;
      });
    });
    if(older) return cb();
    req.qs.offset += req.qs.limit;
    step(cb);
  });
}

