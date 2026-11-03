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
(let ((?x908 (ite $x775 (- k_pending 1) k_pending)))
(let ((?x57 (+ k_pending 1)))
(let ((?x89 (ite (and (= k_op 0) (< k_size k_cap)) ?x57 ?x908)))
(let ((?x54 (ite $x775 (+ k_size 1) k_size)))
(let (($x816 (>= ?x54 0)))
(let (($x354 (> k_cap 0)))
(let (($x753 (and $x354 $x816 (>= ?x89 0) (<= (+ ?x54 ?x89) k_cap))))
(not $x753)))))))))))
(check-sat)
