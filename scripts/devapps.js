var request = require('request');
var async = require('async');
var argv = require('optimist')
    .default('hours', 24)
    .default('host', 'https://dawg.singly.com') .demand(['auth'])
    .usage('node scripts/tops.js --auth dawguser:dawgpass')
    .argv;

var req = {
  url: argv.host+'/apps/logs',
  qs: {
    limit:100,
    offset:0
  },
  headers: {
    Authorization: "Basic " + new Buffer(argv.auth).toString("base64")
  },
  json: true
};
var until = Date.now() - (3600*argv.hours*1000);

var log = console.log;
var error = console.error;

log('<table><tr>');
log('<td>App ID</td><td>Account</td><td>Name</td><td>Social Prof</td><td>Loc</td>');
log('</tr>');

request.get({url:argv.host+'/productionappsactive', headers:req.headers, json:true},
    function(err, resp, apps) {
  if(!Array.isArray(apps)) {
    error("oops",err,apps);
    process.exit(1);
  }
  async.forEachSeries(apps, function(app, cbApp) {
    accounts(app.app, function(acts){
      var alist = Object.keys(acts).slice(0,3);
      async.forEach(alist, function(act, cbAct) {
        request.get({url:argv.host+'/proxy/'+act+'/profile',
          headers:req.headers, json:true}, function(err, resp, profile) {
          logRow(app, act, profile);
          cbAct();
        });
      },cbApp);
    });
  }, function() {
    log('</table>');
    process.exit(0);
  });
});

function logRow(app, act, profile) {
   var html = '<tr>';
   html += '<td>';
   html += '<a href="https://dawg.singly.com/apps/get?key=';
   html += app.app;
   html += '">' + app.app.substring(0, 6) + '</a></td>';
   html += '<td>';
   html += '<a href="https://dawg.singly.com/apps/account?id=' + act;
   html += '">' + act.substring(0, 6) + '</a></td>';
   html += '<td>' + profile.name + '</td>';
   html += '<td><a href="' + profile.url + '">';
   html += profile.handle + '</a></td>';
   html += '</tr>';
   html += '<td>' + profile.location + '</td>';
   log(html);
}

function accounts(app, cb) {
  req.qs.key = app;
  request.get(req, function(err, res, logs){
    var acts = {};
    if(err || !Array.isArray(logs)) return cb(acts);
    logs.forEach(function(log){
      if(log.at < until) return;
      if(!Array.isArray(log.data)) return;
      log.data.forEach(function(hit){
        if(!hit.act || hit.act == 'auth') return;
        if(!acts[hit.act]) acts[hit.act] = true;
      });
    });
    cb(acts);
  });
}
