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
(assert
 (let (($x605 (= k_op 1)))
(let (($x775 (and $x605 (> k_pending 0))))
(let ((?x909 (ite (and (= k_op 0) (< (+ k_size k_pending) k_cap)) (+ k_pending 1) (ite $x775 (- k_pending 1) k_pending))))
(let ((?x54 (ite $x775 (+ k_size 1) k_size)))
(let (($x354 (> k_cap 0)))
(let (($x78 (and $x354 (>= ?x54 0) (>= ?x909 0) (<= (+ ?x54 ?x909) k_cap))))
(not $x78))))))))
(check-sat)
