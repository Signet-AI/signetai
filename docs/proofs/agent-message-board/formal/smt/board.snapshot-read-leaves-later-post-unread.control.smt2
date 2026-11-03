; benchmark generated from python API
(set-info :status unknown)
(declare-fun rs_read () Int)
(declare-fun rs_cutoff () Int)
(declare-fun rs_later () Int)
(declare-fun rs_head () Int)
(assert
 (>= rs_read 0))
(assert
 (>= rs_cutoff rs_read))
(assert
 (> rs_later rs_cutoff))
(assert
 (>= rs_head rs_later))
(assert
 (let ((?x279 (ite (>= rs_read rs_head) rs_read rs_head)))
(let (($x334 (> rs_later ?x279)))
(not $x334))))
(check-sat)
