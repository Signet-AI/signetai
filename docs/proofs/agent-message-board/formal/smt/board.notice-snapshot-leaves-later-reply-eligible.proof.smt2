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
 (let ((?x1162 (ite (>= n_notice n_scanned) n_notice n_scanned)))
(let ((?x535 (ite (>= n_read ?x1162) n_read ?x1162)))
(let ((?x396 (ite (>= ?x535 n_own) ?x535 n_own)))
(let (($x850 (> n_later ?x396)))
(not $x850))))))
(check-sat)
