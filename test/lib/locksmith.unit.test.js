var assert = require('assert');

var lconfig = require('lconfig');
var locksmith = require('locksmith');

var pid = 'pid@service';

describe('locksmith', function() {
  before(function(done) {
    locksmith.init('localworker', done);
  });

  beforeEach(function(done) {
    locksmith.clearLock(pid, done);
  });

  describe('requestLock()', function() {
    it('will grant a previously unclaimed lock, but not a claimed one',
      function(done){
      locksmith.requestLock(pid, function(err, set) {
        assert(!err);
        assert(set);
        locksmith.requestLock(pid, function(err, set) {
          assert(!err);
          assert(!set);
          done();
        });
      });
    });
  });

  describe('isLocked()', function() {
    it('returns false for an unlocked pid', function(done) {
      locksmith.isLocked(pid, function(locked) {
        assert(!locked);
        done();
      });
    });

    it('returns true for a locked pid', function(done) {
      locksmith.requestLock(pid, function(err, set) {
        assert(!err);
        assert(set);
        locksmith.isLocked(pid, function(locked, bits) {
          assert(locked);
          done();
        });
      });
    });
  });

  describe('clearLock()', function() {
    it('can clear the lock for a pid', function(done) {
      locksmith.isLocked(pid, function(locked) {
        assert(!locked);
        locksmith.requestLock(pid, function(err, set) {
          assert(!err);
          assert(set);
          locksmith.clearLock(pid, function(err, cleared) {
            assert(!err);
            assert(cleared);
            done();
          });
        });
      });
    });
  });

  describe('heartbeat()', function() {
    it('can renew a lock it holds', function(done) {
      locksmith.requestLock(pid, function(err, set) {
        assert(!err);
        assert(set);
        locksmith.heartbeat(pid, function(err, heartbeated) {
          assert(!err);
          done();
        });
      });
    });
  });
});
