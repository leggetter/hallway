var sql = "CREATE TABLE IF NOT EXISTS `Entries` (base binary(30) NOT NULL, idr binary(16) NOT NULL, path varchar(128) DEFAULT NULL, hash varchar(32) DEFAULT NULL, offset int(11) DEFAULT NULL, len int(11) DEFAULT NULL, lat decimal(8,5) DEFAULT NULL, lng decimal(8,5) DEFAULT NULL, q0 bigint(20) unsigned DEFAULT NULL, q1 bigint(20) unsigned DEFAULT NULL, q2 bigint(20) unsigned DEFAULT NULL, q3 bigint(20) unsigned DEFAULT NULL, par varbinary(16) DEFAULT NULL, PRIMARY KEY (`base`), UNIQUE KEY `idr_index` (`idr`)) ENGINE=InnoDB DEFAULT CHARSET=utf8;";

for(var i = 0; i < 256; i++)
{
  var hex = i.toString(16);
  if(hex.length == 1) hex = '0'+hex;
  var copy = sql.replace('Entries','Entries_'+hex);
  console.log(copy);
}
