# Singly Hallway - Empowering Personal Data Applications

[![Build Status](https://travis-ci.org/Singly/hallway.png)](https://travis-ci.org/Singly/hallway)

This is an open source project to help developers build amazing applications
combining data from many sources easily, through one API. This codebase is
currently live and powering [api.singly.com](https://api.singly.com/) so sign in
and start building!

[Background Video](http://www.youtube.com/watch?v=pTNO5npNq28)

Follow [@singly](http://twitter.com/singly) and come hang out with us in
[HipChat](http://chat.singly.com/).

We also have a [mailing list](https://groups.google.com/group/singlyapi), join
and say hello!

Let's get started.

## Installing Dependencies

Hallway has the following dependencies:

 * [NodeJS](http://nodejs.org/)
 * [NPM](https://npmjs.org/)
 * [MySQL](http://www.mysql.com/downloads/mysql/5.1.html)
 * [Redis](http://redis.io/)

Detailed instructions for each platform can be found
[here](https://github.com/Singly/hallway/wiki/Installing-hallway-dependencies).

## Building Hallway

Once the dependencies are installed, clone the source code from github using the
following command:

    git clone https://github.com/Singly/hallway.git

Now go to the hallway directory and run make:

    cd hallway
    make

You can now run the following command to ensure node has installed all packages
correctly:

    make test

This should complete without errors.

## Database Setup

You will need to create a MySQL user and database for Hallway. Using the `mysql`
command line tool, run the following command, substituting your own values for
<mysql_username> and <mysql_password>:

    mysql> create database hallway_dev;
    mysql> create user <mysql_username> identified by '<mysql_password>';
    mysql> grant all on hallway_dev.* to hallway;

Once this is done, you can then use the following command to create the necessary tables:

    mysql -u <mysql_username> -p hallway_dev < create_tables.sql

The create_tables.sql script is in the Hallway root directory.  The database
name, `hallway_dev`, must match with the configuration we will do later.  Once
the tables and database are created you can verify they exist by logging in and
doing a show tables:

    mysqlshow -u <mysql_username> -p hallway_dev

You should see all the hallway tables.

## Redis Setup

Redis should have been setup during the initial install.  You can verify that it
is everything is setup and working by running the following commands:

    redis-cli
    info

If everything is up and running you should see an info output.

## Hallway Configuration

Now we need to configure hallway.  Change to the Config directory in hallway and
copy over the apikeys and config files from their examples.

    cd Config
    cp config.json.example config.json
    cp apikeys.json.example apikeys.json

### The config.json File

The first section is the MySQL server setup.  Note that the database name and
username needs to match the one used in the prior section.

     "database": {
        "driver": "mysql",
        "hostname":"localhost",
        "username":"<mysql_username>",
        "password":"<mysql_password>",
        "database":"hallway_dev"
      },

Out of the box, hallway uses the file system to store blobs of JSON data
retrieved from different services. This is configured via the `ijod_backend` and
`ijod_path` parameters, respectively. You can use S3 for blob storage by
changing the configuration to the following:

    "ijod_backend": "s3",
    "s3" : {
        "key":    "<s3_access_key>",
        "secret": "<s3_secret>",
        "bucket": "<s3_bucket>"
    },

You can change the ip address, port, and context path that Hallway runs on using
the lockerHost, lockerPort, externalHost, and externalPort settings.

    "lockerListenIP": "0.0.0.0",
    "lockerHost": "<your local ip address>",
    "lockerPort": 8042,
    "externalHost": "<your local ip address>",
    "externalPath": "<your context path>",
    "externalPort": 8042

You can find other options to set in the `Config/defaults.json` file.

### The apikeys.json File

For each service you want to use with Hallway you will need to register an app
with that service, get your client id and client secret, and paste them into the
apikeys.json file.  A full example of how to get keys per service can be [found
here](https://github.com/Singly/hallway/wiki/GettingAPIKeys).

    {
        "twitter":{
            "appKey":"PASTE_HERE",
            "appSecret":"PASTE_HERE"
        },
        "foursquare" : {
            "appKey" : "PASTE_HERE",
            "appSecret" : "PASTE_HERE"
        },
        "github" : {
            "appKey" : "PASTE_HERE",
            "appSecret" : "PASTE_HERE"
        },
        "facebook" : {
            "appKey" : "PASTE_HERE",
            "appSecret" : "PASTE_HERE"
        },
        ...
    }

When setting up services the callback urls must point back to your local
hallway. For example, when running hallway locally the callback url would be
something like this.

    http://localhost:8042/auth/<service name>/auth.

## Hallway Startup

Once everything is configured you can run the following command to startup
Hallway:

    ./hallway

You should see the following output once hallway is ready to go:

    [10/24/2012 11:44:34][][hallwayd] - Starting an API host
    [10/24/2012 11:44:34][][hallwayd] - Hallway is now listening at http://192.168.1.154:8042
    [10/24/2012 11:44:34][][hallwayd] - Hallway is up and running.

## Using Hallway

To use hallway you will need to setup a test app in the database and then clone
down and use an example app.  To setup a test app in the database run the
following commands and sql.

    mysql -u <admin_username> -p <admin_password> hallway_development
    insert into Apps (app, secret) values ('a_new_app_id', 'a_new_app_secret');

You can give whatever values you like for the app and secret fields.  They
become your client id and client secret for your example app.

You can then follow the instructions for one of the example apps in the "Getting
Started" section of the [Singly docs](http://singly.com/docs).  Your client id
and client secret are the ones you just created and your callback url will be
the local host and port that you have Hallway running on.

Here is the [NodeJS Example](https://singly.com/docs/getting_started_node) to
get started.

## Using Hallway and Pusher

As well as a [socket.io](http://socket.io) streamer for server to client data delivery
there is also a [Pusher](http://pusher.com) streamer which uses the Singly Push API and
pushes updates through Pusher to connected clients.

### Configuring the Pusher streamer

Update `Config/defaults.json` to contain:

    "pusher": {
      "apihost": "http://localhost:8042", // your hallway running instance
      "webhookHost": "http://localhost:8070", // the pusher streamer instance. Used for push API WebHooks
      "port": 8070, // generally the same as webhookHost
      "listenIP": "0.0.0.0",
      "credentials": { // credentials from an application in your Pusher account
        "key": "YOUR_PUSHER_APP_KEY",
        "secret": "YOUR_APP_SECRET",
        "id": "YOUR_APP_ID"
      }
    }

Ensure that the [WebHooks](http://pusher.com/docs/webhooks) endpoint is correctly configured to match `webhookHost` within your Pusher application.
This can be done in the WebHooks settings panel within the Pusher dashboard. The URL for this is:
http://app.pusherapp.com/apps/YOUR_APP_ID/web_hooks

If you are running hallway locally you may need to use a service such as [localtunnel](http://progrium.com/localtunnel/)
to expose the service so that Pusher can access the WebHook endpoint.

### Starting the Pusher streamer

    ./hallway pusher

### Example Client

An example client can be found here: https://github.com/leggetter/pusher-singly-client

### TODO:

* Since [WebHooks](http://pusher.com/docs/webhooks) are used to identify subscriptions it can mean that a subscription won't get
any initial data if the channel is already occupied (because the WebHook won't be triggered). Potential solutions are:
  1. Don't use WebHooks - first subscribe to the channel then make an AJAX call to the streamer service to do the service subscription.
  2. Pusher plan to offer event history. At that point history can be retrieved on the initial subscription. **preferred solution**
* Pusher offers [private channels](http://pusher.com/docs/private_channels) which give a server the opportunity to authenticate a subscription. This may be a better solution than making the `access_token` part of the channel name. **TBD**
