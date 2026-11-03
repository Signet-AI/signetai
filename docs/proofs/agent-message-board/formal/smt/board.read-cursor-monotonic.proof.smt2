; benchmark generated from python API
(set-info :status unknown)
(declare-fun rm_read () Int)
(declare-fun rm_cutoff () Int)
(assert
 (>= rm_read 0))
(assert
 (>= rm_cutoff 0))
(assert
 (let ((?x214 (ite (>= rm_read rm_cutoff) rm_read rm_cutoff)))
(let (($x227 (>= ?x214 rm_read)))
(not $x227))))
(check-sat)
