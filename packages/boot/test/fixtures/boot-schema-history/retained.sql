-- Synthetic, non-secret rows shared by both independently exported historical schemas.
INSERT INTO settings VALUES('retained-setting','not JSON: preserve exactly');
INSERT INTO passkeys VALUES('historical-key','fixture-public-key',7,'["internal"]','Retained passkey',123);
INSERT INTO sessions(id,hash,created_at,expires_at,last_seen_at) VALUES('session','fixture-credential-hash',123,9000000000000,456);
INSERT INTO generations(n,snapshot_dir,entry_file,status,good,started_at,backup_id) VALUES(1,'/historical/gen/1/source','server.ts','retired',1,123,'historical-backup');
INSERT INTO backups(id,path,reason,bytes,taken_at,published_through,generation) VALUES('historical-backup','/historical/backups/old.db','manual',8192,456,42,1);
INSERT INTO cutover(singleton,candidate,prior,backup,lock_id,family,phase,candidate_epoch) VALUES(1,1,NULL,'historical-backup','old-lock','old-family','accepted','retained-epoch');
INSERT INTO db_restore_requests(proof_id,proof_hash,session_id,backup,phase,generation,restored_to_seq,prior_generation) VALUES('historical-proof','fixture-proof-hash','session','historical-backup','restored',1,42,1);
INSERT INTO events(seq,transaction_id,event,topic) VALUES(42,'historical-batch','{ "type":"message.posted", "actor":"fixture", "instance":null, "level":"info", "topic":"root", "body":"acknowledged" }','root');
INSERT INTO event_batches VALUES('historical-batch','retained-epoch',42,42,'committed');
UPDATE seq SET next=43,published_through=42 WHERE singleton=1;
