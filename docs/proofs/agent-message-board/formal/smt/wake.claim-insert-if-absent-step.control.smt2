; benchmark generated from python API
(set-info :status unknown)
(declare-fun c_count () Int)
(declare-fun c_owner () Int)
(declare-fun c_contender () Int)
(declare-fun c_eligible () Bool)
(assert
 (let (($x41 (= c_owner (- 1))))
 (let (($x526 (= $x41 (= c_count 0))))
 (let (($x75 (<= c_count 1)))
 (let (($x430 (>= c_count 0)))
 (let (($x82 (>= c_owner (- 1))))
 (and $x82 $x430 $x75 $x526)))))))
(assert
 (>= c_contender 0))
(assert
 (let (($x315 (= (= (ite (and c_eligible true) c_contender c_owner) (- 1)) (= (ite (and c_eligible true) (+ c_count 1) c_count) 0))))
(let ((?x555 (+ c_count 1)))
(let (($x836 (and c_eligible true)))
(let ((?x151 (ite $x836 ?x555 c_count)))
(let (($x316 (and (>= (ite $x836 c_contender c_owner) (- 1)) (>= ?x151 0) (<= ?x151 1) $x315)))
(not $x316)))))))
(check-sat)
