; benchmark generated from python API
(set-info :status unknown)
(declare-fun k_cap () Int)
(declare-fun k_pending () Int)
(declare-fun k_size () Int)
(declare-fun k_op () Int)
(assert
 (let (($x372 (>= k_pending 0)))
 (let (($x768 (>= k_size 0)))
 (let (($x354 (> k_cap 0)))
 (and $x354 $x768 $x372 (<= (+ k_size k_pending) k_cap))))))
(assert
 (>= k_op 0))
(assert
 (<= k_op 1))
(check-sat)
