; benchmark generated from python API
(set-info :status unknown)
(declare-fun r_count () Int)
(declare-fun r_owner () Int)
(declare-fun r_releaser () Int)
(assert
 (let (($x768 (= (= r_owner (- 1)) (= r_count 0))))
 (let (($x908 (<= r_count 1)))
 (let (($x611 (>= r_count 0)))
 (let (($x344 (>= r_owner (- 1))))
 (and $x344 $x611 $x908 $x768))))))
(assert
 (>= r_owner 0))
(assert
 (>= r_releaser 0))
(check-sat)
