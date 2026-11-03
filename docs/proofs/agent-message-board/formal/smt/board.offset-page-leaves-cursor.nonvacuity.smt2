; benchmark generated from python API
(set-info :status unknown)
(declare-fun o_offset () Int)
(declare-fun o_read () Int)
(declare-fun o_cutoff () Int)
(assert
 (> o_offset 0))
(assert
 (>= o_read 0))
(assert
 (> o_cutoff o_read))
(check-sat)
