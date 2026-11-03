; benchmark generated from python API
(set-info :status unknown)
(declare-fun r_count () Int)
(declare-fun r_owner () Int)
(declare-fun r_releaser () Int)
(assert
 (let (($x354 (= r_count 0)))
 (let (($x909 (= r_owner (- 1))))
 (let (($x768 (= $x909 $x354)))
 (let (($x908 (<= r_count 1)))
 (let (($x611 (>= r_count 0)))
 (let (($x344 (>= r_owner (- 1))))
 (and $x344 $x611 $x908 $x768))))))))
(assert
 (>= r_owner 0))
(assert
 (>= r_releaser 0))
(assert
 (let (($x609 (= r_releaser r_owner)))
(let ((?x365 (ite $x609 (- 1) r_owner)))
(let (($x574 (= ?x365 r_owner)))
(let (($x68 (and (distinct r_releaser r_owner) true)))
(let (($x911 (=> $x68 $x574)))
(let (($x764 (and (>= ?x365 (- 1)) (>= (ite $x609 0 r_count) 0) (<= (ite $x609 0 r_count) 1) (= (= ?x365 (- 1)) (= (ite $x609 0 r_count) 0)))))
(let (($x913 (and $x764 $x911)))
(not $x913)))))))))
(check-sat)
