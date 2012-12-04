var lconfig = require('lconfig');
var logger = require('logger').logger('dawg-aws');

var _ = require('underscore');
var aws = require('aws-lib');

var cloudwatch = aws.createCWClient(lconfig.ec2.accessKeyId,
  lconfig.ec2.secretKey, { version: '2010-08-01' });

var ec2 = aws.createEC2Client(lconfig.ec2.accessKeyId,
  lconfig.ec2.secretKey, { version: '2012-07-20' });

if (!lconfig.ec2) {
  logger.error('You must set ec2.accessKeyId and ec2.secretKey in ' +
    'config.json.');

  process.exit(1);
}

exports.estimatedCharges = function (cb) {
  cloudwatch.call('GetMetricStatistics', {
    'Dimensions.member.1.Name': 'Currency',
    'Dimensions.member.1.Value': 'USD',
    'Namespace': 'AWS/Billing',
    'MetricName': 'EstimatedCharges',
    'Period': 60 * 60 * 6,
    'StartTime': new Date(new Date().valueOf() - 60 * 60 * 24 * 1000)
      .toISOString(),
    'EndTime': new Date().toISOString(),
    'Statistics.member.1': 'Maximum',
    'Unit': 'None'
  }, function (err, res) {
    if (err || !res ||
      !res.GetMetricStatisticsResult ||
      !res.GetMetricStatisticsResult.Datapoints ||
      !res.GetMetricStatisticsResult.Datapoints.member) {
      return cb(err);
    }

    var values = _.map(res.GetMetricStatisticsResult.Datapoints.member,
      function (point) {
      return parseFloat(point.Maximum, 10);
    }).sort(function (a, b) { return b - a; });

    cb(err, values[0]);
  });
};

exports.instanceAddresses = function (groupName, cb) {
  ec2.call('DescribeInstances', {
    'Filter.1.Name': 'group-name',
    'Filter.1.Value.1': groupName,
    'Filter.2.Name': 'instance-state-name',
    'Filter.2.Value.1': 'running'
  }, function (err, res) {
    var addresses = [];

    if (err || !res || !res.reservationSet) {
      return cb(err, addresses);
    }

    if (!Array.isArray(res.reservationSet.item)) {
      res.reservationSet.item = [res.reservationSet.item];
    }

    res.reservationSet.item.forEach(function (reservation) {
      var items = reservation.instancesSet.item;

      if (!Array.isArray(items)) {
        items = [items];
      }

      items.forEach(function (instance) {
        addresses.push({
          publicIp: instance.ipAddress,
          privateIp: instance.privateIpAddress
        });
      });
    });

    cb(null, addresses);
  });
};

exports.instanceCounts = function (cb) {
  try {
    ec2.call('DescribeInstances', {
      'Filter.1.Name': 'instance-state-name',
      'Filter.1.Value.1': 'running'
    }, function (err, res) {
      var names = {};
      var counts = [];

      if (err || !res) {
        return cb(err);
      }

      res.reservationSet.item.forEach(function (reservation) {
        var items = reservation && reservation.instancesSet &&
          reservation.instancesSet.item;

        if (!items) {
          logger.info("Invalid reservation: %j", reservation);

          return;
        }

        if (!Array.isArray(items)) {
          items = [items];
        }

        items.forEach(function (instance) {
          if (!instance.tagSet) {
            return;
          }

          var tagItems = instance.tagSet.item;

          if (!Array.isArray(tagItems)) {
            tagItems = [tagItems];
          }

          var elb = false;

          // We only want instances that are part of an ELB
          tagItems.forEach(function (tag) {
            if (tag.key === 'aws:autoscaling:groupName') {
              elb = true;
            }
          });

          if (elb) {
            tagItems.forEach(function (tag) {
              if (tag.key === 'Name') {
                if (typeof names[tag.value] === 'undefined') {
                  names[tag.value] = 0;
                }

                names[tag.value]++;
              }
            });
          }
        });
      });

      for (var name in names) {
        counts.push({
          name: name,
          count: names[name]
        });
      }

      cb(err, counts);
    });
  } catch (err) {
    cb(err);
  }
};
