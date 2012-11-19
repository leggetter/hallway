var express = require('express');
var connect = require('connect');
var logger = require('logger').logger('stream');
var lutil = require('lutil');
var os = require('os');
var crypto = require('crypto');
var request = require('request');
var Pusher = require('node-pusher');

var tstarted;
var version;
var total;
var api;
var pusherCredentials;
var myself;
var subscriptions = {};
var pusher;

var stream = express.createServer(
  connect.cookieParser(),
  function(req, res, next) {
    logger.debug("REQUEST %s", req.url);
    return next();
  },
  function(req, res, next) {
    var bodyText = '';
    req.setEncoding('utf8');
    req.on('data', function(chunk) { 
     	bodyText += chunk;
    });

    req.on('end', function() {
	    req.rawBody = bodyText;
	    try {
	    	req.body = JSON.parse( bodyText );
	    	logger.debug( "BODY %s", bodyText );
	  	}
	  	catch( err ) { }
	    next();
    });
	},
  // enable CORS
  function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, Authorization");

    // intercept OPTIONS method
    if (req.method === 'OPTIONS') return res.send(200);

    next();
  }
);

// where the push events get sent to!
stream.post('/stream/:channel', function(req, res){
  var channel = req.params.channel;
  if (!subscriptions[ channel ]) return res.send(410);
  res.send(200);
  if (!Array.isArray(req.body)) return;
  req.body.forEach(function(entry){
    // publish to Pusher on the given channel
    pusher.trigger( channel, 'update', entry );
  });
});

stream.post('/auth', function(req, res){
	// Handle pusher auth for channel subscription
	// this way only authenticated users can subscribe to channels.

	// TODO: use 'private-' channels and implement auth
});

stream.post('/webhook', function(req, res){
	// Pusher WebHook call.
	// The event will identify if this means a channel has become occupied (a new subscription should be created)
	// or a a channel has become vacated (the subscription can be stopped).

	// Authenticate the WebHook
	var pusherKeyHeader = req.headers['x-pusher-key'];
  var pusherSignature = req.headers['x-pusher-signature'];

	logger.debug( 'new webhook call', req.rawBody );

  logger.debug( 'creating digest for ', req.rawBody );
  var digest = crypto.createHmac( 'sha256', pusherCredentials.secret ).update( req.rawBody ).digest( 'hex' );
  if ( pusherKeyHeader !== pusherCredentials.key ||
  		 pusherSignature !== digest ) {
      
    console.log("WebHook denied", req.rawBody);
  	res.send({}, 403);
  	return;
  }

  // Determine the events
  var events = req.body.events;
  for (var i=0; i < events.length; i++) {
    var event = events[i].name;
    var channel = events[i].channel;

    if (event == "channel_occupied") {
    	subscribe( channel );
    }
    else if (event == "channel_vacated") {
    	unsubscribe( channel );
    }
  }

  res.send({});
});

function subscribe( channel ) {
	if( subscriptions[ channel ] !== undefined ) {
		return;
	}

	var decoded = new Buffer( channel, 'base64' ).toString( 'utf8' );

	logger.debug( 'decoded subscription as: \n' + decoded );

	var subscription = JSON.parse( decoded );

	subscriptions[ channel ] = subscription;

  var filter = api + subscription.path + '?' + subscription.query;

  // subscription.myself is probably only ever used in testing
	// the reason for this is that you need to start localtunnel after hallway is running
	// and since the config has already been set the localtunnel url can't be used.
  var dest = ( subscription.webhook? subscription.webhook : myself ) + '/stream/' + channel;
  logger.debug("generating new pushback", filter, dest);
  
  var push = {};
  push[ filter ] = { url: dest };

  console.log( 'calling: ' + api + '/push/upsert' );
  request.post({uri:api+'/push/upsert', qs: { access_token: subscription.token }, json: push }, function(err, resp, body) {
    if (err) {
      logger.warn(err);
    }
    if ( resp && resp.statusCode !== 200 ) {
    	logger.warn(resp.statusCode, body);
    }
    else {
    	logger.debug( resp.statusCode, body );
    }
  });
}

function unsubscribe( channel ) {
	if( subscriptions[ channel ] ) {
		delete subscriptions[ channel ];
	}
	else {
		logger.warn( 'unexpected unsubscribe for ' + channel );
	}
}

// public state information
stream.get('/state', function(req, res) {
  var ret = {
    version: version,
    total: total,
    uptime: parseInt((Date.now() - tstarted) / 1000, 10),
    host: require("os").hostname(),
    os: {
      uptime: os.uptime(),
      loadavg: os.loadavg(),
      totalmem: os.totalmem(),
      freemem: os.freemem()
    },
    subscriptions: subscriptions // TODO: should not be public
  };

  res.json(ret);
});

exports.startService = function(arg, cb) {
  logger.info( 'starting Pusher service' );

  stream.listen(arg.port, arg.listenIP, function() {
    cb(stream);
  });

  api = arg.apihost;
  pusherCredentials = arg.credentials;
  myself = arg.webhookHost;
  tstarted = Date.now();
  total = 0;
  pusher = new Pusher({
	  appId: pusherCredentials.id,
	  key: pusherCredentials.key,
	  secret: pusherCredentials.secret
	});

  lutil.currentRevision(function(err, hash) {
    version = hash;
  });
};
