; benchmark generated from python API
(set-info :status unknown)
(declare-fun s_boundary () Int)
(declare-fun s_delivered () Int)
(declare-fun s_global () Int)
(assert
 (>= s_boundary 0))
(assert
 (>= s_global s_delivered))
(assert
 (>= s_delivered 0))
(assert
 (let (($x855 (> s_delivered s_boundary)))
(let ((?x136 (ite $x855 s_global s_boundary)))
(let (($x33 (> s_delivered ?x136)))
(let (($x531 (not $x33)))
(not $x531))))))
(check-sat)
