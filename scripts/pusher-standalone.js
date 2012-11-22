var lconfig = require('lconfig');
var logger = require('logger').logger('pusher-standalone');

// if the runtime provides a port we should use it
lconfig.pusher.port = ( process.env.PORT || lconfig.pusher.port );

logger.info( 'Starting pusher-standalone');

function startPusherStream(cbDone) {
  logger.info("Starting a Hallway Pusher -- you're in for an awesome time.");

  require('pusherStreamer').startService(lconfig.pusher, function() {
    logger.info("Listening for WebHooks on port %d", lconfig.pusher.port);

    cbDone();
  });
}

startPusherStream( function() {} );