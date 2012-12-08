CREATE TABLE IF NOT EXISTS Apps (
       app VARCHAR(255) PRIMARY KEY,
       secret VARCHAR(255),
       apikeys TEXT,
       notes TEXT,
       cat TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Grants (
       code VARCHAR(255) PRIMARY KEY,
       account VARCHAR(255),
       app VARCHAR(255),
       pid VARCHAR(255),
       cat TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Accounts (
       id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
       account VARCHAR(255),
       app VARCHAR(255),
       profile VARCHAR(255),
       cat TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Profiles (
       id VARCHAR(255) PRIMARY KEY,
       service VARCHAR(32),
       auth TEXT,
       config TEXT,
       cat TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS `Entries` (
       base binary(30) NOT NULL,
       idr binary(16) NOT NULL,
       path varchar(128) DEFAULT NULL,
       hash varchar(32) DEFAULT NULL,
       offset int(11) DEFAULT NULL,
       len int(11) DEFAULT NULL,
       lat decimal(8,5) DEFAULT NULL,
       lng decimal(8,5) DEFAULT NULL,
       q0 bigint(20) unsigned DEFAULT NULL,
       q1 bigint(20) unsigned DEFAULT NULL,
       q2 bigint(20) unsigned DEFAULT NULL,
       q3 bigint(20) unsigned DEFAULT NULL,
       par varbinary(16) DEFAULT NULL,
       PRIMARY KEY (`base`),
       UNIQUE KEY `idr_index` (`idr`)
) DEFAULT CHARSET=utf8;
