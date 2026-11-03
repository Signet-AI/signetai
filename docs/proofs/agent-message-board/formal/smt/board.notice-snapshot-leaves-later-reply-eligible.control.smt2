; benchmark generated from python API
(set-info :status unknown)
(declare-fun n_read () Int)
(declare-fun n_notice () Int)
(declare-fun n_own () Int)
(declare-fun n_scanned () Int)
(declare-fun n_later () Int)
(declare-fun n_head () Int)
(assert
 (>= n_read 0))
(assert
 (>= n_notice 0))
(assert
 (>= n_own 0))
(assert
 (>= n_scanned 0))
(assert
 (> n_later n_read))
(assert
 (> n_later n_notice))
(assert
 (> n_later n_own))
(assert
 (> n_later n_scanned))
(assert
 (>= n_head n_later))
(assert
 (let ((?x298 (ite (>= n_notice n_head) n_notice n_head)))
(let ((?x865 (ite (>= n_read ?x298) n_read ?x298)))
(let ((?x1239 (ite (>= ?x865 n_own) ?x865 n_own)))
(let (($x1126 (> n_later ?x1239)))
(not $x1126))))))
(check-sat)
