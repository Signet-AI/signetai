; benchmark generated from python API
(set-info :status unknown)
(declare-sort SourceIdentity 0)
(declare-fun transcript_source () SourceIdentity)
(declare-fun board_source () SourceIdentity)
(declare-fun event_payload () (Array SourceIdentity String))
(assert
 (and (distinct board_source transcript_source) true))
(assert
 (let ((?x14 (select event_payload board_source)))
 (= ?x14 "SYNTHETIC_SHARED_BOARD_EVENT")))
(assert
 (let ((?x309 (select event_payload transcript_source)))
(= ?x309 "SYNTHETIC_SHARED_BOARD_EVENT")))
(check-sat)
