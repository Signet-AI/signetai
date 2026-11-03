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
 (let ((?x514 (ite (>= rs_read rs_cutoff) rs_read rs_cutoff)))
(let (($x937 (> rs_later ?x514)))
(not $x937))))
(check-sat)
