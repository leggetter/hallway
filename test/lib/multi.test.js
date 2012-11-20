var should  = require('should');
var browser = require('supertest');
var Socket = require('net').Socket;

var api = require('webservice').api;
var authManager = require('authManager');
var atok = authManager.provider.generateAccessToken(1, 1, {}).access_token;

var URLS = [
  'http://localhost:8041/v0/services/linkedin/connections?access_token=' + atok,
  'http://localhost:8041/v0/services?access_token=' + atok
];

var MULTI_MULTI = ['/multi', '/v0/multi', 'multi', 'v0/multi'];
var MULTI_SAFE = ['/v0/services/linkedin/multi'];

function isPortOpen(port, callback) {
  var socket = new Socket();
  var portOpen;

  socket.setTimeout(500);

  socket.on('connect', function () {
    portOpen = true;
    socket.end();
  });

  socket.on('timeout', function () {
    portOpen = false;
    socket.destroy();
  });

  socket.on('error', function () {
    portOpen = false;
  });

  // Return after the socket has closed
  socket.on('close', function () {
    callback(null, portOpen);
  });

  socket.connect(port, 'localhost');
}

isPortOpen(8041, function (err, open) {
  // XXX: Skip tests if we can't test the actual endpoint
  if (!open) {
    return;
  }

  // TODO: Faking a user through auth with an account and profiles is hard
  describe('Multi Requests', function () {
    beforeEach(function (done) {
      require('node-fakeweb').tearDown();
      done();
    });

    describe('when you forget the urls parameter', function () {
      it('responds with HTTP 400', function (done) {
        browser(api)
          .get('/multi')
          .expect(400)
          .end(function () {
            done();
          });
      });
    });

    describe('when you include a valid urls parameter', function () {
      it('responds with HTTP 200', function (done) {
        var url = '/multi?urls=' + encodeURIComponent(URLS.join(','));
        browser(api)
          .get(url)
          .expect(200)
          .end(function (err, res) {
            for (var i in URLS) {
              should.exist(res.body[URLS[i]]);
            }
            done();
          });
      });
    });

    describe('when you include a urls parameter that is too long', function () {
      it('responds with HTTP 400', function (done) {
        var lots = [];
        for (var i = 0; i < 200; i++) {
          lots.push(URLS[i % 2]);
        }
        var url = '/multi?urls=' + encodeURIComponent(lots.join(','));
        browser(api)
          .get(url)
          .expect(400)
          .end(done);
      });
    });

    describe('when you include a call to the /multi endpoint', function () {
      it('doesn\'t allow it', function (done) {
        var url = '/multi?urls=' + encodeURIComponent(MULTI_MULTI.join(','));
        browser(api)
          .get(url)
          .expect(200)
          .end(function (err, resp) {
            for (var i in MULTI_MULTI) {
              should.exist(resp.body[MULTI_MULTI[i]].error);
              should.not.exist(resp.body[MULTI_MULTI[i]].body);
            }
            done();
          });
      });
    });

    // this one isn't great, because in theory, the error could contain the
    // word error from somewhere else
    describe('when you call a URL containing the word multi', function () {
      it('does allow it', function (done) {
        var url = '/multi?urls=' + encodeURIComponent(MULTI_SAFE.join(','));
        browser(api)
          .get(url)
          .expect(200)
          .end(function (err, resp) {
            for (var i in MULTI_SAFE) {
              var multiErr = resp.body[MULTI_SAFE[i]].error;
              should.equal(multiErr.toString().indexOf('mulit'), -1);
            }
            done();
          });
      });
    });
  });
});
