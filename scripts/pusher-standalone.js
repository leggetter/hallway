var lconfig = require('lconfig');

console.dir( lconfig );

var logger = require('logger').logger('pusher-standalone');

logger.info( 'Starting pusher-standalone');

function startPusherStream(cbDone) {
  logger.info("Starting a Hallway Pusher -- you're in for an awesome time.");

  require('pusherStreamer').startService(lconfig.pusher, function() {
    logger.info("Listening for WebHooks on port %d", lconfig.pusher.port);

    cbDone();
  });
}

startPusherStream( function() {} );