var connect = require('connect');
var crypto = require('crypto');
var express = require('express');
var Pusher = require('node-pusher');
var request = require('request');

var logger = require('logger').logger('pusherStreamer');
var hostStatus = require('host-status').status;

var TOTAL = 0;

var api;
var pusherCredentials;
var myself;
var subscriptions = {};
var pusher;

function subscribe(channel) {
  if (subscriptions[channel] !== undefined) {
    return;
  }

  var decoded = new Buffer(channel, 'base64').toString('utf8');

  logger.debug('decoded subscription as: \n' + decoded);

  var subscription = JSON.parse(decoded);

  subscriptions[channel] = subscription;

  var filter = api + subscription.path + '?' + subscription.query;

  // subscription.myself is probably only ever used in testing the reason for
  // this is that you need to start localtunnel after hallway is running and
  // since the config has already been set the localtunnel url can't be used.
  var dest = (subscription.webhook ? subscription.webhook : myself) +
    '/stream/' + channel;

  logger.debug("generating new pushback", filter, dest);

  var push = {};

  push[filter] = { url: dest };

  logger.log('calling: ' + api + '/push/upsert');

  request.post({
    uri: api + '/push/upsert',
    qs: { access_token: subscription.token },
    json: push
  }, function (err, resp, body) {
    if (err) {
      logger.warn(err);
    }

    if (resp) {
      if (resp.statusCode !== 200) {
        logger.warn(resp.statusCode, body);

        pusher.trigger(channel, 'singly:subscription_error', {
          statusCode: resp.StatusCode,
          body: body
        });
      } else {
        pusher.trigger(channel, 'singly:subscription_succeeded', {
          statusCode: resp.StatusCode
        });
      }
    }
  });
}

function unsubscribe(channel) {
  if (subscriptions[channel]) {
    delete subscriptions[channel];

    pusher.trigger(channel, 'singly:unsubscribe_succeeded', {});
  } else {
    logger.warn('unexpected unsubscribe for ' + channel);
  }
}

var stream = express();

stream.use(connect.cookieParser());
stream.use(connect.bodyParser());

stream.use(function (req, res, next) {
  logger.debug("REQUEST %s", req.url);

  TOTAL++;

  return next();
});

// enable CORS
stream.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "X-Requested-With, Authorization");

  // intercept OPTIONS method
  if (req.method === 'OPTIONS') return res.send(200);

  next();
});

// where the push events get sent to!
stream.post('/stream/:channel', function (req, res) {
  var channel = req.params.channel;

  var decoded = new Buffer(channel, 'base64').toString('utf8');

  logger.debug('stream push recieved for: \n' + decoded);

  if (!subscriptions[channel]) {
    logger.warn('could not find channel subscription for:');
    logger.warn('encoded: %s', channel);
    logger.warn('decoded: %s', decoded);

    return res.send(410);
  }

  res.send(200);

  if (!Array.isArray(req.body)) {
    logger.warn('request body was not an Array of entries:');
    logger.warn('encoded: %s', channel);
    logger.warn('decoded: %s', decoded);

    return;
  }

  pusher.trigger(channel, 'singly:data_received', req.body);
});

//stream.post('/auth', function (req, res) {
  // Handle pusher auth for channel subscription
  // this way only authenticated users can subscribe to channels.

  // TODO: use 'private-' channels and implement auth
//});

stream.post('/webhook', function (req, res) {
  // The event will identify if this means a channel has become occupied (a new
  // subscription should be created) or a a channel has become vacated (the
  // subscription can be stopped).

  // Authenticate the WebHook
  var pusherKeyHeader = req.headers['x-pusher-key'];
  var pusherSignature = req.headers['x-pusher-signature'];

  logger.debug('new webhook call', req.rawBody);
  logger.debug('creating digest for ', req.rawBody);

  var digest = crypto.createHmac('sha256', pusherCredentials.secret)
    .update(req.rawBody).digest('hex');

  if (pusherKeyHeader !== pusherCredentials.key ||
    pusherSignature !== digest) {
    console.log("WebHook denied", req.rawBody);

    return res.send({}, 403);
  }

  // Determine the events
  var events = req.body.events;

  for (var i = 0; i < events.length; i++) {
    var event = events[i].name;
    var channel = events[i].channel;

    if (event === "channel_occupied") {
      subscribe(channel);
    } else if (event === "channel_vacated") {
      unsubscribe(channel);
    }
  }

  res.send({});
});

// public state information
stream.get('/state', function (req, res) {
  var ret = hostStatus();

  ret.subscriptions = subscriptions; // TODO: should not be public
  ret.total = TOTAL;

  res.json(ret);
});

exports.startService = function (arg, cb) {
  logger.info('starting Pusher service');

  stream.listen(arg.port, arg.listenIP, function () {
    cb(stream);
  });

  api = arg.apihost;
  pusherCredentials = arg.credentials;
  myself = arg.webhookHost;

  pusher = new Pusher({
    appId: pusherCredentials.id,
    key: pusherCredentials.key,
    secret: pusherCredentials.secret
  });
};
