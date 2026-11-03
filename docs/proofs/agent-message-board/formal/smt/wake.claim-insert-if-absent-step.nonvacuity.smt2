; benchmark generated from python API
(set-info :status unknown)
(declare-fun c_count () Int)
(declare-fun c_owner () Int)
(declare-fun c_contender () Int)
(assert
 (let (($x41 (= c_owner (- 1))))
 (let (($x526 (= $x41 (= c_count 0))))
 (let (($x75 (<= c_count 1)))
 (let (($x430 (>= c_count 0)))
 (let (($x82 (>= c_owner (- 1))))
 (and $x82 $x430 $x75 $x526)))))))
(assert
 (>= c_contender 0))
(check-sat)
