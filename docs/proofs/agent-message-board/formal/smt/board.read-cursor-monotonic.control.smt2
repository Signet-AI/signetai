; benchmark generated from python API
(set-info :status unknown)
(declare-fun rm_read () Int)
(declare-fun rm_cutoff () Int)
(assert
 (>= rm_read 0))
(assert
 (>= rm_cutoff 0))
(assert
 (let (($x1036 (>= rm_cutoff rm_read)))
(not $x1036)))
(check-sat)
